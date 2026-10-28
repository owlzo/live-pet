/**
 * 直播接入服务：连本地 WS 转发器、把消息归一化成 LiveEvent、去重、排队抽样，再交给动作映射。
 *
 * 只负责「收 → 归一化 → 去重 → 排队 → 按节奏交出去」；不决定宠物做什么（归 ./handlers），也不画界面。
 * 源地址支持 `mock://` 前缀：没有抖音转发器时也能跑通整条链路（控制台「模拟事件」用它）。
 * 采集器（douyinLive）的探测与拉起归 ./collector，这里只在启动时问它一句「在跑吗」。
 * 必须始终成立：断线自动重连且只保留一条连接；所有异常只记日志，绝不抛出到调用方。
 * @module live-pet/src/live/index
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Deduper } from './dedupe.ts';
import { InteractionQueue, estimateSpeechMs, type QueuedInteraction } from './queue.ts';
import { createCollector, resolveCollectorExecutable, type Collector, type CollectorStatus } from './collector.ts';
import type { LiveEvent, LiveEventKind, LiveMode, LiveStatus } from './types.ts';

/** 持久化的直播配置。 */
export interface LiveConfig {
  /** 接入模式：ai = 弹幕走大模型；readonly = 单机模式（只读弹幕 + 礼物固定话术）。 */
  mode: LiveMode;
  /** 转发器地址模板，`{room}` 会被替换成房间号；`mock://` 表示内置模拟源。 */
  sourceUrl: string;
  /** 上次使用的房间号。 */
  room: string;
  /** 启动时自动连接（房间号非空且不是模拟源时生效）。 */
  autoConnect: boolean;
  /** 去重窗口（秒）。 */
  dedupeWindowSec: number;
  /** 窗口内同一用户同一内容最多放行次数。 */
  dedupeMaxPerWindow: number;
  /** 待播队列上限，同时也是抽样批的批量（默认 50）。 */
  maxPending: number;
  /** 抽样比例 0~1：一批里留下多少（默认 0.5 = 50 条留一半）。礼物不受影响。 */
  sampleRatio: number;
  /** 抽样批最多等多久（毫秒）就强制决策一次。 */
  flushMs: number;
  /** 两条播报之间的最小间隔（毫秒）；实际间隔还会按文本长度估的语音时长拉长。 */
  outputGapMs: number;
  /** 采集器可执行文件绝对路径；空串 = 不自动拉起。 */
  collectorPath: string;
  /** 启动时是否自动拉起采集器（端口没在听才拉）。 */
  collectorAutoStart: boolean;
}

/** 默认配置：对接 douyinLive（Go 单文件转发器）的本地 WS。 */
export const DEFAULT_LIVE_CONFIG: LiveConfig = {
  // 默认单机模式：没配模型也能正常直播，弹幕照读、礼物照谢，不产生 API 费用。
  mode: 'readonly',
  sourceUrl: 'ws://127.0.0.1:1088/ws/{room}',
  room: '',
  autoConnect: true,
  dedupeWindowSec: 30,
  dedupeMaxPerWindow: 3,
  // 排队与抽样：人多时按批抽一半，留下的仍按到达顺序一句一句播
  maxPending: 50,
  sampleRatio: 0.5,
  flushMs: 3000,
  outputGapMs: 2200,
  collectorPath: '',
  collectorAutoStart: true,
};

/** 服务依赖：日志、事件出口、配置文件路径。 */
export interface LiveDeps {
  log: { info(message: string): void; warn(message: string): void };
  /**
   * 通过去重的事件出口（动作映射在调用方）；第二个参数是当前模式。
   *
   * 返回「这一条实际播出去的文本」：队列据此估算下一条该等多久（语音念完再念下一条）。
   * 返回 undefined / 空串 = 这条没出声（例如 AI 模式没配模型、只读模式下的进场），不占用播报节奏。
   */
  onEvent: (event: LiveEvent, mode: LiveMode) => void | string | Promise<void | string>;
  /** live-config.json 的绝对路径。 */
  configPath: string;
  /** 采集器日志落到哪个文件（默认与 live-config.json 同目录的 collector.log）。 */
  collectorLogPath?: string;
}

/** 对外能力。 */
export interface LiveService {
  status(): LiveStatus;
  config(): LiveConfig;
  updateConfig(patch: Partial<LiveConfig>): LiveConfig;
  connect(room?: string): void;
  disconnect(): void;
  /**
   * 直接注入一条事件（控制台测试 / 其它平台适配层）。
   *
   * @param event - 归一化后的事件。
   * @param immediate - true = 跳过抽样直接排队（手工点击，必须立刻可见）；
   *   缺省 false = 与 WS 源同一条队列，参与抽样（外部转发器的真实流量）。
   */
  inject(event: LiveEvent, immediate?: boolean): boolean;
  /** 最近的互动记录（含被抽样丢弃的），最新在前。 */
  history(limit?: number): QueuedInteraction[];
  /** 采集器状态（是否在跑、路径、pid）。 */
  collectorStatus(): CollectorStatus;
  /** 确保采集器在跑（没配路径 / 端口已在听时直接返回现状）。 */
  ensureCollector(): Promise<CollectorStatus>;
  dispose(): void;
}

/** 从对象里按候选路径取第一个非空字符串。 */
function pickString(source: unknown, paths: readonly string[]): string | undefined {
  for (const path of paths) {
    let cur: unknown = source;
    for (const seg of path.split('.')) {
      if (cur === null || typeof cur !== 'object') {
        cur = undefined;
        break;
      }
      cur = (cur as Record<string, unknown>)[seg];
    }
    if (typeof cur === 'string' && cur.trim() !== '') return cur.trim();
    if (typeof cur === 'number' && Number.isFinite(cur)) return String(cur);
  }
  return undefined;
}

/** 从对象里按候选路径取第一个有限数字。 */
function pickNumber(source: unknown, paths: readonly string[]): number | undefined {
  for (const path of paths) {
    let cur: unknown = source;
    for (const seg of path.split('.')) {
      if (cur === null || typeof cur !== 'object') {
        cur = undefined;
        break;
      }
      cur = (cur as Record<string, unknown>)[seg];
    }
    const n = Number(cur);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

/** 消息里的类型标识 → 五类事件；认不出的返回 null（直接丢弃）。 */
export function classify(raw: unknown): LiveEventKind | null {
  const tag = (pickString(raw, ['method', 'methodName', 'type', 'msgType', 'event', 'name']) ?? '').toLowerCase();
  if (tag.includes('gift')) return 'gift';
  if (tag.includes('member') || tag.includes('enter')) return 'enter';
  if (tag.includes('like') || tag.includes('digg')) return 'like';
  if (tag.includes('follow') || tag.includes('social')) return 'follow';
  if (tag.includes('chat') || tag.includes('comment') || tag.includes('danmaku')) return 'chat';
  return null;
}

/**
 * 把转发器的原始 JSON 归一化成 LiveEvent。
 *
 * 字段名做了多套兼容（抖音 protobuf 转 JSON 的命名在不同转发器里不一致）；
 * 认不出类型或没有正文的弹幕返回 null。
 */
export function normalize(raw: unknown): LiveEvent | null {
  const kind = classify(raw);
  if (kind === null) return null;
  const user =
    pickString(raw, ['user.nickname', 'user.nickName', 'user.name', 'nickname', 'userName', 'user']) ?? '匿名';
  const text = pickString(raw, ['content', 'text', 'message', 'chatContent', 'danmaku']);
  const giftName = pickString(raw, ['gift.name', 'giftName', 'gift_name', 'gift.nameText']);
  const giftCount = pickNumber(raw, ['gift.repeatCount', 'gift.count', 'repeatCount', 'giftCount', 'count']) ?? 1;
  if (kind === 'chat' && (text === undefined || text === '')) return null;
  if (kind === 'gift' && giftName === undefined) return null;
  const event: LiveEvent = { kind, user, ts: Date.now(), raw };
  if (text !== undefined) event.text = text;
  if (kind === 'gift') {
    event.giftName = giftName;
    event.giftCount = giftCount;
  }
  return event;
}

/** 从直播源地址里解析出「采集器应该监听在哪」；解析不出来就退回默认的 127.0.0.1:1088。 */
function endpointOf(config: LiveConfig): { host: string; port: number } {
  try {
    const url = new URL(config.sourceUrl.replace('{room}', config.room === '' ? '0' : config.room));
    const fallbackPort = url.protocol === 'wss:' || url.protocol === 'https:' ? 443 : 80;
    const port = Number(url.port === '' ? String(fallbackPort) : url.port);
    return {
      host: url.hostname === '' ? '127.0.0.1' : url.hostname,
      port: Number.isFinite(port) && port > 0 ? port : 1088,
    };
  } catch {
    return { host: '127.0.0.1', port: 1088 };
  }
}

/** 创建直播接入服务。 */
export function createLiveService(deps: LiveDeps): LiveService {
  const { log } = deps;

  let config: LiveConfig = { ...DEFAULT_LIVE_CONFIG };
  try {
    const parsed = JSON.parse(readFileSync(deps.configPath, 'utf8')) as Partial<LiveConfig>;
    config = { ...config, ...parsed };
  } catch {
    // 首次运行没有配置文件：用默认值，不打扰用户
  }

  let deduper = new Deduper({ windowMs: config.dedupeWindowSec * 1000, maxPerWindow: config.dedupeMaxPerWindow });
  const queue = new InteractionQueue({
    maxPending: config.maxPending,
    sampleRatio: config.sampleRatio,
    flushMs: config.flushMs,
  });

  let socket: WebSocket | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelayMs = 1000;
  let stopped = true;
  let mockTimer: ReturnType<typeof setInterval> | undefined;

  const counters = { received: 0 };
  let lastEvent: LiveStatus['lastEvent'];
  let lastError: string | undefined;
  let connectedAt: number | undefined;

  // ---- 播报节奏：队列里一条一条念，念完（按文本估时长）再放下一条 ----
  let pumpTimer: ReturnType<typeof setInterval> | undefined;
  /** 下一条最早可以播的时刻（毫秒）。 */
  let nextPlayAt = 0;
  /** 正在播报（等 onEvent 返回）时为 true，避免并发播两条。 */
  let playing = false;

  // ---- 采集器 ----
  let collector: Collector | undefined;
  let collectorState: CollectorStatus | undefined;

  const persist = (): void => {
    try {
      writeFileSync(deps.configPath, JSON.stringify(config, null, 2), 'utf8');
    } catch (error) {
      log.warn(`[live-pet] 直播配置写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** 采集器控制器按需创建（路径/端口变了要重建，所以不提前 new）。 */
  const collectorInstance = (): Collector => {
    if (collector === undefined) {
      const endpoint = endpointOf(config);
      // 路径三档解析：配置 > 环境变量 > 标准安装目录（setup:collector 就装在那里）
      const executable = resolveCollectorExecutable(config.collectorPath, dirname(deps.configPath));
      collector = createCollector({
        executable,
        host: endpoint.host,
        port: endpoint.port,
        logPath: deps.collectorLogPath ?? join(dirname(deps.configPath), 'collector.log'),
        log,
      });
    }
    return collector;
  };

  const ensureCollector = async (): Promise<CollectorStatus> => {
    // 关掉自动拉起且没配路径：什么都不做，也别去探测（探测会白等 800ms）
    if (!config.collectorAutoStart && config.collectorPath === '') {
      collectorState = { configured: false, running: false, path: '' };
      return collectorState;
    }
    try {
      collectorState = await collectorInstance().ensure();
      if (collectorState.running) {
        log.info(`[live-pet] 采集器就绪：${collectorState.path || '（外部进程）'}`);
      } else if (collectorState.lastError !== undefined) {
        log.warn(`[live-pet] 采集器不可用：${collectorState.lastError}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      collectorState = {
        configured: config.collectorPath !== '',
        running: false,
        path: config.collectorPath,
        lastError: message,
      };
      log.warn(`[live-pet] 采集器启动异常：${message}`);
    }
    return collectorState;
  };

  /**
   * 收到一条事件：计数 → 去重 → 入队。
   *
   * 注意这里**不再**直接交给动作映射：入队后由 {@link pump} 按节奏出队，
   * 否则弹幕一多，每条都立刻写 say 叶子，后一条会把前一条顶掉，看起来就像「没读完」。
   *
   * @returns true = 通过去重并已入队（不代表马上会播）；false = 被去重抑制。
   */
  const emit = (event: LiveEvent): boolean => {
    counters.received += 1;
    // 长直播里键只增不减会慢慢吃内存；每 200 条清一次过期键（窗口过期的条目本就该丢）。
    if (counters.received % 200 === 0) deduper.prune();
    if (!deduper.admit(event)) {
      log.info(`[live-pet] 直播事件被去重抑制：${event.kind} ${event.user}`);
      return false;
    }
    queue.push(event, Date.now());
    return true;
  };

  /** 播报泵：一拍里先做抽样决策，再看能不能出队播下一条。 */
  const pump = (): void => {
    const now = Date.now();
    queue.flush(now);
    if (playing || now < nextPlayAt) return;
    const item = queue.take(now);
    if (item === undefined) return;

    playing = true;
    lastEvent = {
      kind: item.event.kind,
      user: item.event.user,
      text: item.event.text ?? item.event.giftName,
      ts: item.event.ts,
    };
    Promise.resolve()
      .then(() => deps.onEvent(item.event, config.mode))
      .then((spoken) => {
        // 有出声才按语音时长排下一拍；没出声（只读模式的进场/点赞）只按最小间隔
        const text = typeof spoken === 'string' ? spoken : '';
        const speechMs = text === '' ? 0 : estimateSpeechMs(text) + 250;
        nextPlayAt = Date.now() + Math.max(config.outputGapMs, speechMs);
      })
      .catch((error) => {
        log.warn(`[live-pet] 直播事件处理失败：${error instanceof Error ? error.message : String(error)}`);
        nextPlayAt = Date.now() + config.outputGapMs;
      })
      .finally(() => {
        playing = false;
      });
  };

  const stopSocket = (): void => {
    stopped = true;
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    if (mockTimer !== undefined) {
      clearInterval(mockTimer);
      mockTimer = undefined;
    }
    const cur = socket;
    socket = undefined;
    if (cur) {
      try {
        cur.close();
      } catch {
        // 已关闭的连接再 close 会抛，忽略
      }
    }
    connectedAt = undefined;
  };

  const scheduleRetry = (reason: string): void => {
    if (stopped) return;
    lastError = reason;
    const delay = retryDelayMs;
    retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
    log.warn(`[live-pet] 直播源断开（${reason}），${Math.round(delay / 1000)}s 后重连`);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      openSocket();
    }, delay);
  };

  const openSocket = (): void => {
    if (stopped) return;
    const url = config.sourceUrl.replace('{room}', encodeURIComponent(config.room));

    if (url.startsWith('mock://')) {
      // 内置模拟源：每 3 秒一条弹幕、每 15 秒一个礼物，用于没有转发器时跑通链路
      connectedAt = Date.now();
      lastError = undefined;
      log.info('[live-pet] 直播源已连接（内置模拟源）');
      let n = 0;
      mockTimer = setInterval(() => {
        n += 1;
        if (n % 5 === 0) {
          emit({ kind: 'gift', user: '模拟观众' + n, giftName: '小心心', giftCount: 1, ts: Date.now() });
        } else {
          emit({ kind: 'chat', user: '模拟观众' + n, text: '主播好呀 ' + n, ts: Date.now() });
        }
      }, 3000);
      return;
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      scheduleRetry(error instanceof Error ? error.message : String(error));
      return;
    }
    socket = ws;
    ws.addEventListener('open', () => {
      retryDelayMs = 1000;
      connectedAt = Date.now();
      lastError = undefined;
      log.info(`[live-pet] 直播源已连接：${url}`);
    });
    ws.addEventListener('message', (event: MessageEvent) => {
      const data = typeof event.data === 'string' ? event.data : String(event.data ?? '');
      if (data === '') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return; // 非 JSON（心跳/二进制）直接忽略
      }
      const normalized = normalize(parsed);
      if (normalized) emit(normalized);
    });
    ws.addEventListener('error', () => {
      lastError = '连接错误';
    });
    ws.addEventListener('close', () => {
      if (stopped) return;
      scheduleRetry('连接关闭');
    });
  };

  // 播报泵常驻：没连上时队列是空的，空转成本可以忽略；好处是连上之前注入的事件也能播出去。
  pumpTimer = setInterval(pump, 200);

  // 开播即连：房间号已填且不是模拟源时，进程启动后直接建立连接。
  // 模拟源要手动点（它是测试用的，自动跑会一直刷假弹幕）。
  const shouldAutoConnect = config.autoConnect && config.room !== '' && !config.sourceUrl.startsWith('mock://');
  // 采集器预热：配了自动拉起就先拉起来。它只在「有客户端连了某个房间」时才去连抖音上游，
  // 空跑不产生任何外网流量；好处是控制台一打开就是「运行中」，用户只要填房间号就能连。
  const shouldWarmCollector = config.collectorAutoStart;
  if (shouldAutoConnect || shouldWarmCollector) {
    setTimeout(() => {
      // 先拉采集器，再连它的端口；采集器起得慢也没关系，重连会兜住
      void ensureCollector();
      if (!shouldAutoConnect) return;
      stopped = false;
      openSocket();
      log.info(`[live-pet] 自动连接直播源：房间=${config.room}`);
    }, 0);
  }

  return {
    status(): LiveStatus {
      const stats = queue.stats();
      return {
        mode: config.mode,
        connected: connectedAt !== undefined,
        source: config.sourceUrl.replace('{room}', config.room ? '***' : '{room}'),
        room: config.room,
        received: counters.received,
        delivered: stats.played,
        suppressed: deduper.suppressedCount(),
        queued: stats.queued,
        batch: stats.batch,
        droppedSampled: stats.droppedSampled,
        droppedQueueFull: stats.droppedQueueFull,
        collector: collectorState ?? {
          configured: config.collectorPath !== '',
          running: false,
          path: config.collectorPath,
        },
        ...(lastEvent === undefined ? {} : { lastEvent }),
        ...(lastError === undefined ? {} : { lastError }),
        ...(connectedAt === undefined ? {} : { connectedAt }),
      };
    },
    config(): LiveConfig {
      return { ...config };
    },
    updateConfig(patch: Partial<LiveConfig>): LiveConfig {
      const beforePath = config.collectorPath;
      config = {
        ...config,
        ...patch,
        mode: patch.mode === 'ai' || patch.mode === 'readonly' ? patch.mode : config.mode,
        dedupeWindowSec: Math.max(1, Math.min(3600, Number(patch.dedupeWindowSec ?? config.dedupeWindowSec))),
        dedupeMaxPerWindow: Math.max(1, Math.min(100, Number(patch.dedupeMaxPerWindow ?? config.dedupeMaxPerWindow))),
        maxPending: Math.max(1, Math.min(500, Number(patch.maxPending ?? config.maxPending))),
        sampleRatio: Math.max(0, Math.min(1, Number(patch.sampleRatio ?? config.sampleRatio))),
        flushMs: Math.max(200, Math.min(60000, Number(patch.flushMs ?? config.flushMs))),
        outputGapMs: Math.max(200, Math.min(60000, Number(patch.outputGapMs ?? config.outputGapMs))),
      };
      deduper = new Deduper({ windowMs: config.dedupeWindowSec * 1000, maxPerWindow: config.dedupeMaxPerWindow });
      queue.setOptions({
        maxPending: config.maxPending,
        sampleRatio: config.sampleRatio,
        flushMs: config.flushMs,
      });
      // 采集器路径变了：停掉旧的、丢掉句柄，下次 ensure 用新路径重建
      if (config.collectorPath !== beforePath) {
        collector?.stop();
        collector = undefined;
        collectorState = undefined;
      }
      persist();
      return { ...config };
    },
    connect(room?: string): void {
      if (room !== undefined && room !== '') config.room = room.trim();
      persist();
      stopSocket();
      // 换房间等于换一场直播：上一场没播完的、历史里的都不再保留
      queue.reset();
      nextPlayAt = 0;
      stopped = false;
      retryDelayMs = 1000;
      deduper.reset();
      log.info(`[live-pet] 直播接入启动：房间=${config.room || '(未填)'} 源=${config.sourceUrl}`);
      void ensureCollector();
      openSocket();
    },
    disconnect(): void {
      stopSocket();
      log.info('[live-pet] 直播接入已断开');
    },
    inject(event: LiveEvent, immediate = false): boolean {
      // 两条注入路径共用这里，差别只在「要不要抽样」：
      // - 控制台「模拟事件」（immediate=true）：点了就得马上看到气泡，否则用户以为坏了；
      // - 外部转发器 /live/ingest（immediate=false）：那是真实流量，必须和 WS 源一样进队列排队，
      //   否则人多时照样刷屏——这条曾经漏过，导致路线 B 完全绕过抽样。
      counters.received += 1;
      if (!deduper.admit(event)) {
        log.info(`[live-pet] 直播事件被去重抑制：${event.kind} ${event.user}`);
        return false;
      }
      if (immediate) queue.pushNow(event, Date.now());
      else queue.push(event, Date.now());
      return true;
    },
    history(limit?: number): QueuedInteraction[] {
      return queue.history(limit);
    },
    collectorStatus(): CollectorStatus {
      return (
        collectorState ?? {
          configured: config.collectorPath !== '',
          running: false,
          path: config.collectorPath,
        }
      );
    },
    ensureCollector,
    dispose(): void {
      stopSocket();
      if (pumpTimer !== undefined) {
        clearInterval(pumpTimer);
        pumpTimer = undefined;
      }
      collector?.stop();
      collector = undefined;
    },
  };
}
