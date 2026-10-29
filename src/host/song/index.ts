/**
 * 点歌服务：把「弹幕指令 → 搜索 → 守卫 → 队列 → 投递 → 观测」串成一条状态机。
 *
 * 三层职责分得很清：解析在 `src/live/song/command`，判定在 `./guard`，排队在 `./queue`；
 * 这里只做编排与计时，因此可以整体注入假适配器做端到端单测。
 *
 * 必须始终成立：
 * 1. 队列推进不依赖播放回执——协议没有回执，只有「窗口标题 + 曲目时长」两个外部信号；
 * 2. 任何一步失败都只降级（跳过这一首），绝不让异常冒到直播事件泵上；
 * 3. 播报与投递之间留 `announce.delayMs`，避免桌宠 TTS 与歌曲人声叠在一起。
 * @module live-pet/src/host/song/index
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseSongCommand, normalizeSongKey } from '../../live/song/command.ts';
import { judgeSong, normalizeGuardConfig } from './guard.ts';
import { createNeteaseAdapter, type NeteaseAdapter } from './netease.ts';
import { normalizeQueueConfig, SongQueue } from './queue.ts';
import {
  DEFAULT_SONG_CONFIG,
  type SongCandidate,
  type SongClientHealth,
  type SongConfig,
  type SongReason,
  type SongRequest,
  type SongStatusView,
} from './types.ts';

/** 服务依赖。 */
export interface SongDeps {
  /** 日志出口。 */
  log: { info(message: string): void; warn(message: string): void };
  /** `song-config.json` 的绝对路径。 */
  configPath: string;
  /** 播报出口（写 `pets.<id>.say`）；缺省不播报，只记日志。 */
  announce?: (text: string) => void;
  /** 适配器（测试注入；缺省用真实网易云客户端）。 */
  adapter?: NeteaseAdapter;
  /** 时钟（测试注入）。 */
  now?: () => number;
  /** 状态机拍子（毫秒）；测试可放大以免抢跑。 */
  tickMs?: number;
}

/** 一次点歌请求的处理结果（控制台与弹幕共用）。 */
export interface SongRequestOutcome {
  ok: boolean;
  /** 要播报出去的那句话；空串 = 不播报。 */
  message: string;
  /** 成功时带请求条目。 */
  request?: SongRequest;
  /** 失败原因。 */
  reason?: SongReason;
}

/** 对外能力。 */
export interface SongService {
  status(): SongStatusView;
  config(): SongConfig;
  updateConfig(patch: unknown): SongConfig;
  /** 弹幕入口：不是点歌指令（或功能关闭）返回 undefined，交回普通弹幕流程。 */
  handleChat(user: string, text: string): Promise<string | undefined>;
  /** 点歌（控制台手工同一条路径）。 */
  request(input: { user: string; text: string; keyword?: string }): Promise<SongRequestOutcome>;
  /** 跳过当前这首。 */
  skip(): boolean;
  /** 删掉待播里的一条。 */
  remove(id: number): boolean;
  /** 清空待播。 */
  clear(): number;
  /** 搜索候选（控制台调试用，不判守卫）。 */
  search(keyword: string): Promise<SongCandidate[]>;
  /** 确保客户端在跑（不在跑就尝试拉起）。 */
  ensureClient(): Promise<boolean>;
  /** 历史（最新在前）。 */
  history(limit?: number): SongRequest[];
  /**
   * 手动推进一拍状态机。
   *
   * 生产环境由内部定时器调用；暴露出来是为了让单测能确定性地推进时间，
   * 不必依赖真实 sleep（那会让断言随机器负载飘）。
   */
  tick(): Promise<void>;
  dispose(): void;
}

/** 单次尝试的最小间隔：挡住「换着歌名连点」的刷屏。 */
const ATTEMPT_GAP_MS = 3000;

/** 播放失败后的同曲冷却：避免同一首被反复点、反复失败。 */
const FAILED_SONG_COOLDOWN_MS = 24 * 3600_000;

/** 数值收敛。 */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** 布尔收敛：只认真正的 true/false，其余回落默认。 */
function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** 把任意来源的配置补齐并收敛成合法值（HTTP 请求体是不可信输入）。 */
export function normalizeSongConfig(raw: unknown, fallback: SongConfig = DEFAULT_SONG_CONFIG): SongConfig {
  const o = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const netease = o.netease !== null && typeof o.netease === 'object' ? (o.netease as Record<string, unknown>) : {};
  const playback = o.playback !== null && typeof o.playback === 'object' ? (o.playback as Record<string, unknown>) : {};
  const announce = o.announce !== null && typeof o.announce === 'object' ? (o.announce as Record<string, unknown>) : {};
  return {
    enabled: boolOr(o.enabled, fallback.enabled),
    accepting: boolOr(o.accepting, fallback.accepting),
    netease: {
      exePath: typeof netease.exePath === 'string' ? netease.exePath.trim() : fallback.netease.exePath,
      autoLaunch: boolOr(netease.autoLaunch, fallback.netease.autoLaunch),
      launchMinimized: boolOr(netease.launchMinimized, fallback.netease.launchMinimized),
      commandGapMs: clampInt(netease.commandGapMs, 100, 5000, fallback.netease.commandGapMs),
    },
    guard: normalizeGuardConfig(o.guard as never, fallback.guard),
    queue: normalizeQueueConfig(o.queue as never, fallback.queue),
    playback: {
      playLimitSec: clampInt(playback.playLimitSec, 0, 3600, fallback.playback.playLimitSec),
      // 下限压到 200ms：联调与单测都要能在「秒级」内走完一次确认，不必真等 3 秒
      verifyDelayMs: clampInt(playback.verifyDelayMs, 200, 15000, fallback.playback.verifyDelayMs),
      pollIntervalMs: clampInt(playback.pollIntervalMs, 200, 30000, fallback.playback.pollIntervalMs),
      tailMs: clampInt(playback.tailMs, 0, 10000, fallback.playback.tailMs),
    },
    announce: {
      enabled: boolOr(announce.enabled, fallback.announce.enabled),
      delayMs: clampInt(announce.delayMs, 0, 15000, fallback.announce.delayMs),
    },
  };
}

/** 标题是否指向目标曲目：两者都归一化后做包含比较（标题是「歌名 - 歌手」）。 */
export function titleMatchesSong(title: string, song: SongCandidate): boolean {
  const titleKey = normalizeSongKey(title);
  const songKey = normalizeSongKey(song.title);
  if (titleKey === '' || songKey === '') return false;
  return titleKey.includes(songKey);
}

/** 拒绝原因 → 给观众的一句话（不暴露内部规则细节）。 */
function rejectMessage(reason: SongReason, keyword: string): string {
  switch (reason) {
    case 'not-found':
      return `没找到《${keyword}》，换个名字试试`;
    case 'banned-word':
    case 'blacklist-song':
    case 'blacklist-artist':
      return '这首不能播哦，换一首吧';
    case 'unverified':
      return '这首还没确认能不能播，先跳过啦';
    case 'too-long':
      return '这首太长了，换一首吧';
    case 'duplicate':
      return '这首刚点过啦，等会儿再点';
    case 'cooldown':
      return '歇一会儿再点哦';
    case 'quota':
      return '今天点得有点多啦，明天再来';
    case 'queue-full':
      return '排队满啦，等会儿再来';
    case 'no-client':
      return '播放器没开，稍等一下';
    case 'paused':
      return '现在暂停接歌哦';
    default:
      return '这首放不了，换一首吧';
  }
}

/** 创建点歌服务。 */
export function createSongService(deps: SongDeps): SongService {
  const { log } = deps;
  const now = deps.now ?? (() => Date.now());
  const adapter: NeteaseAdapter =
    deps.adapter ??
    createNeteaseAdapter({
      log,
      exePath: () => config.netease.exePath,
    });

  let config: SongConfig = { ...DEFAULT_SONG_CONFIG };
  try {
    const parsed: unknown = JSON.parse(readFileSync(deps.configPath, 'utf8'));
    config = normalizeSongConfig(parsed, DEFAULT_SONG_CONFIG);
  } catch {
    // 首次运行没有配置文件：用默认值（全关），不打扰用户
  }

  const queue = new SongQueue(config.queue);
  /** 正在处理的那一条（requesting / playing）。 */
  let current: SongRequest | undefined;
  /** 报幕结束、允许投递的时刻。 */
  let dispatchAt = 0;
  /** 上一次投递时刻（控制 commandGapMs）。 */
  let lastDispatchAt = 0;
  /** 上一次探测时刻（控制 pollIntervalMs）。 */
  let lastProbeAt = 0;
  /** 预计播完的时刻。 */
  let endsAt = 0;
  /** 探测与投递并发保护。 */
  let busy = false;
  let disposed = false;
  let lastError: string | undefined;
  /** 客户端健康度缓存（`/song/status` 直接展示）。 */
  let client: SongClientHealth = { running: false, title: '' };
  /** 每人最近一次尝试时刻：与队列配额无关，纯粹防刷。 */
  const lastAttempt = new Map<string, number>();
  /** 播放失败过的曲目 → 冷却截止时刻。 */
  const failedSongs = new Map<string, number>();
  const counts = { accepted: 0, played: 0, failed: 0, rejected: 0 };

  const persist = (): void => {
    try {
      mkdirSync(dirname(deps.configPath), { recursive: true });
      writeFileSync(deps.configPath, JSON.stringify(config, null, 2), 'utf8');
    } catch (error) {
      log.warn(`[live-pet] 点歌配置写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** 播报：关掉时只记日志，保证行为可预期。 */
  const say = (text: string): void => {
    if (text === '') return;
    log.info(`[live-pet] 点歌播报：${text}`);
    if (!config.announce.enabled) return;
    deps.announce?.(text);
  };

  /** 结束当前这首，准备下一首。 */
  const settle = (status: 'ended' | 'failed', reason?: SongReason): void => {
    if (current === undefined) return;
    queue.finish(current, status, now(), reason);
    if (status === 'ended') {
      counts.played += 1;
    } else {
      counts.failed += 1;
      if (current.song !== undefined) failedSongs.set(current.song.id, now() + FAILED_SONG_COOLDOWN_MS);
      say(`《${current.song?.title ?? '这首歌'}》放不了，跳过`);
    }
    current = undefined;
    dispatchAt = 0;
    endsAt = 0;
  };

  /** 投递一次播放命令。 */
  const dispatch = async (item: SongRequest): Promise<void> => {
    if (item.song === undefined) {
      settle('failed', 'play-failed');
      return;
    }
    const gap = config.netease.commandGapMs;
    const wait = Math.max(0, lastDispatchAt + gap - now());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      await adapter.play(item.song.id);
      item.dispatchedAt = now();
      lastDispatchAt = now();
      log.info(`[live-pet] 点歌投递 song=${item.song.id} 《${item.song.title}》`);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      log.warn(`[live-pet] 点歌投递失败：${lastError}`);
      settle('failed', 'play-failed');
    }
  };

  /** 确保客户端在跑：不在跑就先拉起一次，等窗口出来再确认。 */
  const ensureClient = async (): Promise<boolean> => {
    client = await adapter.probe();
    if (client.running) return true;
    const launched = await adapter.launch();
    if (!launched) return false;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    client = await adapter.probe();
    return client.running;
  };

  /** 开始下一首：先报幕，隔 delayMs 再投递。 */
  const startNext = (): void => {
    if (current !== undefined || disposed) return;
    if (!config.accepting) return;
    const item = queue.take(now());
    if (item === undefined) return;
    current = item;
    dispatchAt = now() + config.announce.delayMs;
    lastProbeAt = 0;
    if (item.song !== undefined) {
      say(`接下来播放 ${item.user} 点的《${item.song.title}》`);
    }
  };

  /** 一拍状态机。 */
  const tick = async (): Promise<void> => {
    if (disposed || busy) return;
    busy = true;
    try {
      const t = now();
      if (current === undefined) {
        startNext();
        return;
      }
      if (current.status === 'requesting') {
        // 还没到投递点（报幕中）
        if (current.dispatchedAt === undefined) {
          if (t < dispatchAt) return;
          const alive = await ensureClient();
          if (!alive) {
            lastError = '播放器未运行';
            settle('failed', 'no-client');
            return;
          }
          await dispatch(current);
          return;
        }
        // 已投递：等确认窗口过去再看窗口标题
        if (t - current.dispatchedAt < config.playback.verifyDelayMs) return;
        client = await adapter.probe();
        lastProbeAt = t;
        if (titleMatchesSong(client.title, current.song as SongCandidate)) {
          queue.markPlaying(current);
          const limit = config.playback.playLimitSec;
          const duration = current.song?.durationMs ?? 0;
          const playMs = limit > 0 ? Math.min(duration > 0 ? duration : limit * 1000, limit * 1000) : duration;
          endsAt = t + (playMs > 0 ? playMs : limit * 1000) + config.playback.tailMs;
          log.info(`[live-pet] 点歌开始播放 《${current.song?.title ?? ''}》 预计 ${Math.round((endsAt - t) / 1000)}s`);
          return;
        }
        // 没切过去：重投一次，仍不行就放弃
        const retries = current.retries ?? 0;
        if (retries < 1) {
          current.retries = retries + 1;
          current.dispatchedAt = undefined;
          dispatchAt = 0;
          log.warn('[live-pet] 点歌未确认播放，重投一次');
          return;
        }
        lastError = '投递后未观察到播放';
        settle('failed', 'play-failed');
        return;
      }
      if (current.status === 'playing') {
        if (endsAt > 0 && t >= endsAt) {
          settle('ended');
          startNext();
          return;
        }
        // 轮询标题：主播手动切歌时队列要跟上，不能干等时长
        if (t - lastProbeAt < config.playback.pollIntervalMs) return;
        client = await adapter.probe();
        lastProbeAt = t;
        if (!client.running) {
          lastError = '播放器已退出';
          settle('failed', 'no-client');
          return;
        }
        if (!titleMatchesSong(client.title, current.song as SongCandidate)) {
          log.info('[live-pet] 点歌被切走或已结束，推进队列');
          settle('ended');
          startNext();
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      log.warn(`[live-pet] 点歌状态机异常：${lastError}`);
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void tick(), deps.tickMs ?? 500);
  timer.unref?.();

  // 预热：开启且配置了自动拉起时，启动就把客户端拉起来，之后点歌不会再弹新窗口
  if (config.enabled && config.netease.autoLaunch) {
    void ensureClient().catch(() => undefined);
  }

  const reject = (reason: SongReason, keyword: string): SongRequestOutcome => {
    counts.rejected += 1;
    return { ok: false, message: rejectMessage(reason, keyword), reason };
  };

  return {
    status(): SongStatusView {
      const stats = queue.stats();
      return {
        enabled: config.enabled,
        accepting: config.accepting,
        playing: current ?? null,
        pending: queue.items(),
        counts: { ...counts, accepted: stats.accepted },
        client: { ...client },
        ...(lastError === undefined ? {} : { lastError }),
      };
    },

    config(): SongConfig {
      return structuredClone(config);
    },

    updateConfig(patch: unknown): SongConfig {
      const merged = { ...config, ...(patch !== null && typeof patch === 'object' ? (patch as Record<string, unknown>) : {}) };
      config = normalizeSongConfig(merged, config);
      queue.setOptions(config.queue);
      persist();
      // 从关到开时补一次预热，省得第一首点歌要等客户端冷启动
      if (config.enabled && config.netease.autoLaunch) void ensureClient().catch(() => undefined);
      return structuredClone(config);
    },

    async handleChat(user: string, text: string): Promise<string | undefined> {
      const command = parseSongCommand(text);
      if (command === null) return undefined;
      if (!config.enabled) return undefined; // 功能关着：当作普通弹幕，不改变既有行为
      if (!config.accepting) return undefined; // 暂停接单时保持安静，避免刷屏
      const outcome = await this.request({ user, text, keyword: command.keyword });
      return outcome.message === '' ? undefined : outcome.message;
    },

    async request(input: { user: string; text: string; keyword?: string }): Promise<SongRequestOutcome> {
      const keyword = (input.keyword ?? input.text).trim();
      if (!config.enabled) return reject('disabled', keyword);
      if (!config.accepting) return reject('paused', keyword);

      // 防刷：同一用户 3 秒内只受理一次尝试（无论成败）。
      // 首次尝试没有「上一次」——不能用 0 当默认值，否则进程启动后的前三秒会把所有人都挡住。
      const t = now();
      const last = lastAttempt.get(input.user);
      if (last !== undefined && t - last < ATTEMPT_GAP_MS) return reject('cooldown', keyword);
      lastAttempt.set(input.user, t);

      const candidates = await adapter.search(keyword, 3);
      const candidate = candidates[0];
      if (candidate === undefined) return reject('not-found', keyword);

      const failedUntil = failedSongs.get(candidate.id) ?? 0;
      if (failedUntil > t) return reject('play-failed', keyword);

      const decision = judgeSong({ candidate, keyword, config: config.guard });
      if (decision.verdict === 'block') {
        log.info(`[live-pet] 点歌被拦：${decision.reason ?? 'unknown'}（${decision.note}）`);
        return reject(decision.reason ?? 'unverified', keyword);
      }

      const pushed = queue.push({
        user: input.user,
        raw: input.text,
        song: candidate,
        verdict: decision.verdict,
        ...(decision.note === undefined ? {} : { note: decision.note }),
        now: t,
      });
      if (!pushed.ok) return reject(pushed.reason, keyword);

      const position = queue.size + (current === undefined ? 0 : 1);
      log.info(`[live-pet] 点歌入队 #${pushed.item.id} ${input.user} 《${candidate.title}》 第 ${position} 位`);
      const message = position <= 1 ? `收到「${input.user}」点的《${candidate.title}》，马上播放` : `收到「${input.user}」点的《${candidate.title}》，排第 ${position} 位`;
      return { ok: true, message, request: pushed.item };
    },

    skip(): boolean {
      if (current === undefined) return false;
      log.info('[live-pet] 点歌被手动切走');
      settle('ended');
      startNext();
      return true;
    },

    remove(id: number): boolean {
      return queue.remove(id, now());
    },

    clear(): number {
      return queue.clear();
    },

    async search(keyword: string): Promise<SongCandidate[]> {
      return adapter.search(keyword, 5);
    },

    ensureClient,

    history(limit = 50): SongRequest[] {
      return queue.listHistory(limit);
    },

    tick,

    dispose(): void {
      disposed = true;
      clearInterval(timer);
    },
  };
}
