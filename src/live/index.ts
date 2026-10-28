/**
 * 直播接入服务：连本地 WS 转发器、把消息归一化成 LiveEvent、去重后交给动作映射。
 *
 * 只负责「收 → 归一化 → 去重 → 交出去」；不决定宠物做什么（归 ./handlers），也不画界面。
 * 源地址支持 `mock://` 前缀：没有抖音转发器时也能跑通整条链路（控制台「模拟事件」用它）。
 * 必须始终成立：断线自动重连且只保留一条连接；所有异常只记日志，绝不抛出到调用方。
 * @module live-pet/src/live/index
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Deduper } from './dedupe.ts';
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
};

/** 服务依赖：日志、事件出口、配置文件路径。 */
export interface LiveDeps {
  log: { info(message: string): void; warn(message: string): void };
  /** 通过去重的事件出口（动作映射在调用方）；第二个参数是当前模式。 */
  onEvent: (event: LiveEvent, mode: LiveMode) => void | Promise<void>;
  /** live-config.json 的绝对路径。 */
  configPath: string;
}

/** 对外能力。 */
export interface LiveService {
  status(): LiveStatus;
  config(): LiveConfig;
  updateConfig(patch: Partial<LiveConfig>): LiveConfig;
  connect(room?: string): void;
  disconnect(): void;
  /** 直接注入一条事件（控制台测试 / 其它平台适配层）。 */
  inject(event: LiveEvent): boolean;
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
  const tag = (
    pickString(raw, ['method', 'methodName', 'type', 'msgType', 'event', 'name']) ?? ''
  ).toLowerCase();
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
  let socket: WebSocket | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelayMs = 1000;
  let stopped = true;
  let mockTimer: ReturnType<typeof setInterval> | undefined;

  const counters = { received: 0, delivered: 0 };
  let lastEvent: LiveStatus['lastEvent'];
  let lastError: string | undefined;
  let connectedAt: number | undefined;

  const persist = (): void => {
    try {
      writeFileSync(deps.configPath, JSON.stringify(config, null, 2), 'utf8');
    } catch (error) {
      log.warn(`[live-pet] 直播配置写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const emit = (event: LiveEvent): boolean => {
    counters.received += 1;
    // 长直播里键只增不减会慢慢吃内存；每 200 条清一次过期键（窗口过期的条目本就该丢）。
    if (counters.received % 200 === 0) deduper.prune();
    // 长直播里键只增不减会慢慢吃内存；每 200 条清一次过期键（窗口过期的条目本就该丢）。
    if (counters.received % 200 === 0) deduper.prune();
    if (!deduper.admit(event)) return false;
    counters.delivered += 1;
    lastEvent = { kind: event.kind, user: event.user, text: event.text ?? event.giftName, ts: event.ts };
    try {
      void deps.onEvent(event, config.mode);
    } catch (error) {
      log.warn(`[live-pet] 直播事件处理失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return true;
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

  // 开播即连：房间号已填且不是模拟源时，进程启动后直接建立连接。
  // 模拟源要手动点（它是测试用的，自动跑会一直刷假弹幕）。
  if (config.autoConnect && config.room !== '' && !config.sourceUrl.startsWith('mock://')) {
    setTimeout(() => {
      stopped = false;
      openSocket();
      log.info(`[live-pet] 自动连接直播源：房间=${config.room}`);
    }, 0);
  }

  return {
    status(): LiveStatus {
      return {
        mode: config.mode,
        connected: connectedAt !== undefined,
        source: config.sourceUrl.replace('{room}', config.room ? '***' : '{room}'),
        room: config.room,
        received: counters.received,
        delivered: counters.delivered,
        suppressed: deduper.suppressedCount(),
        ...(lastEvent === undefined ? {} : { lastEvent }),
        ...(lastError === undefined ? {} : { lastError }),
        ...(connectedAt === undefined ? {} : { connectedAt }),
      };
    },
    config(): LiveConfig {
      return { ...config };
    },
    updateConfig(patch: Partial<LiveConfig>): LiveConfig {
      config = {
        ...config,
        ...patch,
        mode: patch.mode === 'ai' || patch.mode === 'readonly' ? patch.mode : config.mode,
        dedupeWindowSec: Math.max(1, Math.min(3600, Number(patch.dedupeWindowSec ?? config.dedupeWindowSec))),
        dedupeMaxPerWindow: Math.max(1, Math.min(100, Number(patch.dedupeMaxPerWindow ?? config.dedupeMaxPerWindow))),
      };
      deduper = new Deduper({ windowMs: config.dedupeWindowSec * 1000, maxPerWindow: config.dedupeMaxPerWindow });
      persist();
      return { ...config };
    },
    connect(room?: string): void {
      if (room !== undefined && room !== '') config.room = room.trim();
      persist();
      stopSocket();
      stopped = false;
      retryDelayMs = 1000;
      deduper.reset();
      log.info(`[live-pet] 直播接入启动：房间=${config.room || '(未填)'} 源=${config.sourceUrl}`);
      openSocket();
    },
    disconnect(): void {
      stopSocket();
      log.info('[live-pet] 直播接入已断开');
    },
    inject(event: LiveEvent): boolean {
      const admitted = emit(event);
      if (!admitted) log.info(`[live-pet] 直播事件被去重抑制：${event.kind} ${event.user}`);
      return admitted;
    },
    dispose(): void {
      stopSocket();
    },
  };
}
