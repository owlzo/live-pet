/**
 * 采集器进程管理：检测端口、按需拉起 douyinLive、退出时回收。
 *
 * 为什么放在宿主里：弹幕采集器（douyinLive）和桌宠是两件事，但用户眼里只有「启动桌宠」一件事。
 * 之前要手工开第二个终端跑采集器，少开一个就整条链路空转——控制台一直「未连接」，日志刷重连。
 * 这里把「先探测、没在跑就拉起来」收进宿主，让 `npm run start:app` 一条命令可用。
 *
 * 边界：
 * - 路径来源三档：配置里的 collectorPath > 环境变量 LIVE_PET_COLLECTOR_PATH > 标准安装目录
 *   （见 {@link resolveCollectorExecutable}）；仍找不到就不拉，绝不替用户下载；
 * - 只杀「自己拉起来的那个进程」，用户手工开的采集器不动（`managed` 标记区分）；
 * - 探测失败一律降级为「没在跑」，不抛错——采集器缺席时桌宠照常运行，只是收不到弹幕。
 * @module live-pet/src/live/collector
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';

/** 采集器运行状态（控制台直接展示）。 */
export interface CollectorStatus {
  /** 配置里是否填了可执行文件路径。 */
  configured: boolean;
  /** 端口是否可连（在跑）。 */
  running: boolean;
  /** 配置的路径（原样返回，便于用户核对）。 */
  path: string;
  /** 自己拉起的进程 pid；用户手工开的不填。 */
  pid?: number;
  /** 最近一次失败原因。 */
  lastError?: string;
}

/** 采集器依赖。 */
export interface CollectorDeps {
  /** 可执行文件绝对路径；空串 = 未配置（不会自动拉起）。 */
  executable: string;
  /** 采集器监听地址与端口（从直播源地址解析得到）。 */
  host: string;
  port: number;
  /** 采集器自身输出落到哪个文件。 */
  logPath: string;
  /** 宿主日志出口。 */
  log: { info(message: string): void; warn(message: string): void };
}

/** 采集器控制器。 */
export interface Collector {
  status(): CollectorStatus;
  /** 探测端口；没在跑且配了路径就拉起来。幂等，可重复调用。 */
  ensure(): Promise<CollectorStatus>;
  /** 只回收自己拉起的进程。 */
  stop(): void;
}

/** 端口探测超时：本机 loopback 正常在毫秒级返回，超过这个值一律当「没在跑」。 */
const PROBE_TIMEOUT_MS = 800;
/** 拉起后等多久再确认一次端口（采集器启动 + 监听通常 < 1s）。 */
const SPAWN_CONFIRM_MS = 1500;

/** 采集器可执行文件名（按平台）。 */
const COLLECTOR_BIN = process.platform === 'win32' ? 'douyinLive.exe' : 'douyinLive';

/**
 * 解析采集器可执行文件：显式配置 > 环境变量 > 标准安装位置。
 *
 * 为什么要这一步：`collectorPath` 留空时旧行为是「不自动拉起」，用户就得记住去控制台粘一条
 * 绝对路径——而 `npm run setup:collector` 已经把文件放在固定位置了，再让用户手抄一遍纯属多余。
 * 这里只认「我们自己的标准目录」，不去全盘搜索，也不替用户下载。
 *
 * @param configured - 配置里的 collectorPath（可能为空）。
 * @param configDir - live-config.json 所在目录（= 用户数据目录下的 live-pet/）。
 * @param env - 环境变量（注入便于单测）。
 * @returns 可执行文件绝对路径；都找不到返回空串（调用方据此报「未配置」）。
 */
export function resolveCollectorExecutable(
  configured: string,
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = configured.trim();
  if (explicit !== '') return explicit; // 用户填了就用它，存在与否交给 ensure 报错
  const fromEnv = (env.LIVE_PET_COLLECTOR_PATH ?? '').trim();
  if (fromEnv !== '') return fromEnv;
  // 两个标准位置：<数据目录>/tools/…（setup 脚本装这里）与它上一级的同名目录（历史布局）
  const candidates = [
    join(configDir, 'tools', 'douyinLive', COLLECTOR_BIN),
    join(dirname(configDir), 'tools', 'douyinLive', COLLECTOR_BIN),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return '';
}

/**
 * 探测某个本机端口是否有人在听。
 *
 * @param host - 主机名（127.0.0.1 / localhost）。
 * @param port - 端口号。
 * @returns 可连为 true；超时、拒绝、域名解析失败都为 false。
 */
export function probePort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    const socket = connect({ host, port });
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** 创建采集器控制器。 */
export function createCollector(deps: CollectorDeps): Collector {
  const { log } = deps;
  let child: ChildProcess | undefined;
  let lastError: string | undefined;
  let ensuring: Promise<CollectorStatus> | undefined;

  const status = (running: boolean): CollectorStatus => ({
    configured: deps.executable !== '',
    running,
    path: deps.executable,
    ...(child?.pid === undefined ? {} : { pid: child.pid }),
    ...(lastError === undefined ? {} : { lastError }),
  });

  /** 拉起进程（只在 ensure 内部调用）。 */
  function spawnProcess(): void {
    const cwd = dirname(deps.executable);
    let fd: number | undefined;
    try {
      fd = openSync(deps.logPath, 'a');
      child = spawn(deps.executable, [], {
        cwd,
        // 采集器是常驻服务：输出接日志文件，不占宿主的标准输出
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      });
      child.once('exit', (code, signal) => {
        // 自己退出（端口被占、崩溃）时清掉引用，下次 ensure 会重新拉起
        log.warn(`[live-pet] 采集器已退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`);
        child = undefined;
      });
      child.once('error', (error) => {
        lastError = error.message;
        log.warn(`[live-pet] 采集器启动失败：${error.message}`);
        child = undefined;
      });
      log.info(`[live-pet] 已拉起采集器：${deps.executable}（pid=${child.pid ?? '?'}）`);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      log.warn(`[live-pet] 采集器启动失败：${lastError}`);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /** 真正的探测 + 拉起流程（串行化，避免并发 ensure 拉起两个进程）。 */
  async function doEnsure(): Promise<CollectorStatus> {
    const alive = await probePort(deps.host, deps.port);
    if (alive) {
      lastError = undefined;
      return status(true);
    }
    if (deps.executable === '') {
      lastError = '未配置采集器路径，无法自动启动';
      return status(false);
    }
    if (!existsSync(deps.executable)) {
      lastError = `采集器不存在：${deps.executable}`;
      return status(false);
    }
    spawnProcess();
    // 给进程一点时间监听端口，再确认一次（失败也照样返回，交给上层展示）
    await new Promise((resolve) => setTimeout(resolve, SPAWN_CONFIRM_MS));
    const up = await probePort(deps.host, deps.port);
    if (!up && lastError === undefined) lastError = `采集器已启动但端口 ${deps.port} 未监听`;
    return status(up);
  }

  return {
    status(): CollectorStatus {
      // 同步接口：只反映「有没有我们拉起的进程」，真实端口状态由 ensure 更新
      return status(child !== undefined);
    },
    ensure(): Promise<CollectorStatus> {
      ensuring = ensuring === undefined ? doEnsure() : ensuring.then(doEnsure, doEnsure);
      return ensuring;
    },
    stop(): void {
      const cur = child;
      child = undefined;
      if (cur === undefined || cur.pid === undefined) return;
      try {
        cur.kill();
        log.info(`[live-pet] 已停止采集器（pid=${cur.pid}）`);
      } catch (error) {
        log.warn(`[live-pet] 停止采集器失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
