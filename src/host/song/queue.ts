/**
 * 点歌队列：只管「谁排在第几」与「还能不能接」，不搜索、不播放、不判版权。
 *
 * 与直播互动队列（`src/live/queue.ts`）是两张表，**不能复用**：那张表会按比例抽样丢条目（歌必丢）、
 * 上限语义是「播报缓冲」；这里的条目一条都不能丢，且要按用户做配额与去重。
 * 必须始终成立：队列只装「已通过守卫」的请求；被拒的请求连进都不进，只在服务层计数。
 * @module live-pet/src/host/song/queue
 */

import type { SongCandidate, SongQueueConfig, SongReason, SongRequest, SongVerdict } from './types.ts';

/** 入队参数。 */
export interface SongQueuePushInput {
  /** 点歌人。 */
  readonly user: string;
  /** 观众原话。 */
  readonly raw: string;
  /** 命中的曲目。 */
  readonly song: SongCandidate;
  /** 守卫结论（allow / review）。 */
  readonly verdict: SongVerdict;
  /** 守卫依据。 */
  readonly note?: string;
  /** 入队时刻。 */
  readonly now: number;
}

/** 入队结果：成功给条目，失败给原因。 */
export type SongQueuePushResult =
  | { readonly ok: true; readonly item: SongRequest }
  | { readonly ok: false; readonly reason: SongReason };

/** 队列计数。 */
export interface SongQueueStats {
  pending: number;
  accepted: number;
  dropped: number;
}

/** 历史保留条数：控制台只看最近这些，够复盘。 */
const HISTORY_LIMIT = 200;

/** 数值收敛。 */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** 队列参数收敛：外部写进来的值一律夹到合法区间。 */
export function normalizeQueueConfig(raw: Partial<SongQueueConfig> | undefined, fallback: SongQueueConfig): SongQueueConfig {
  return {
    maxPending: clampInt(raw?.maxPending, 1, 100, fallback.maxPending),
    perUserCooldownSec: clampInt(raw?.perUserCooldownSec, 0, 3600, fallback.perUserCooldownSec),
    perUserMaxPerHour: clampInt(raw?.perUserMaxPerHour, 1, 60, fallback.perUserMaxPerHour),
    duplicateWindowSec: clampInt(raw?.duplicateWindowSec, 0, 21600, fallback.duplicateWindowSec),
  };
}

/**
 * 点歌队列（进程内内存态，重启即空）。
 *
 * 计时全部由调用方注入 `now`，自己不起定时器——与 `InteractionQueue` 同一套写法，便于单测。
 */
export class SongQueue {
  private options: SongQueueConfig;
  private seq = 0;
  /** 待播队列（不含正在播的那条）。 */
  private pending: SongRequest[] = [];
  /** 全部记录（含已播/失败），尾部最新。 */
  private history: SongRequest[] = [];
  private accepted = 0;
  private dropped = 0;

  /** @param options - 初始参数（已收敛）。 */
  constructor(options: SongQueueConfig) {
    this.options = normalizeQueueConfig(options, options);
  }

  /** 当前参数（拷贝）。 */
  getOptions(): SongQueueConfig {
    return { ...this.options };
  }

  /** 改参数：只影响之后的判定，已在队列里的不动。 */
  setOptions(patch: Partial<SongQueueConfig>): SongQueueConfig {
    this.options = normalizeQueueConfig({ ...this.options, ...patch }, this.options);
    return { ...this.options };
  }

  /**
   * 尝试入队。
   *
   * 四道闸按「越具体越先判」排：重复 → 冷却 → 配额 → 队满。
   * 顺序有意义：同一首歌重复点，用户该看到「刚点过」而不是「队列满了」。
   */
  push(input: SongQueuePushInput): SongQueuePushResult {
    const { song, user, now } = input;

    if (this.isDuplicate(song.id, now)) {
      this.dropped += 1;
      return { ok: false, reason: 'duplicate' };
    }
    if (this.isCoolingDown(user, now)) {
      this.dropped += 1;
      return { ok: false, reason: 'cooldown' };
    }
    if (this.countUserInWindow(user, now, 3600_000) >= this.options.perUserMaxPerHour) {
      this.dropped += 1;
      return { ok: false, reason: 'quota' };
    }
    if (this.pending.length >= this.options.maxPending) {
      this.dropped += 1;
      return { ok: false, reason: 'queue-full' };
    }

    this.seq += 1;
    const item: SongRequest = {
      id: this.seq,
      user,
      raw: input.raw,
      song,
      status: 'pending',
      verdict: input.verdict,
      ...(input.note === undefined ? {} : { note: input.note }),
      createdAt: now,
    };
    this.pending.push(item);
    this.record(item);
    this.accepted += 1;
    return { ok: true, item };
  }

  /**
   * 取下一条待播（FIFO），并把它标成 requesting。
   *
   * @param now - 当前时刻。
   * @returns 队首；空队列返回 undefined。
   */
  take(now: number): SongRequest | undefined {
    const item = this.pending.shift();
    if (item === undefined) return undefined;
    item.status = 'requesting';
    item.startedAt = now;
    return item;
  }

  /** 标记为在播（观测确认之后）。 */
  markPlaying(item: SongRequest): void {
    item.status = 'playing';
  }

  /** 收尾：ended = 正常播完或被切走；failed = 放不出来。 */
  finish(item: SongRequest, status: 'ended' | 'failed', now: number, reason?: SongReason): void {
    item.status = status;
    item.endedAt = now;
    if (reason !== undefined) item.reason = reason;
  }

  /**
   * 从待播队列里删一条（正在播的那条不在这里）。
   *
   * @param id - 请求序号。
   * @param now - 当前时刻（由调用方注入，保持与其余方法同一口径）。
   */
  remove(id: number, now: number): boolean {
    const index = this.pending.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const [removed] = this.pending.splice(index, 1);
    if (removed !== undefined) {
      removed.status = 'ended';
      removed.endedAt = now;
      removed.reason = 'paused';
    }
    return true;
  }

  /** 清空待播（正在播的不动）。 */
  clear(): number {
    const count = this.pending.length;
    this.pending = [];
    return count;
  }

  /** 待播条数。 */
  get size(): number {
    return this.pending.length;
  }

  /** 待播列表（拷贝，外部改不到内部）。 */
  items(): SongRequest[] {
    return [...this.pending];
  }

  /** 计数。 */
  stats(): SongQueueStats {
    return { pending: this.pending.length, accepted: this.accepted, dropped: this.dropped };
  }

  /** 历史（最新在前）。 */
  listHistory(limit = 50): SongRequest[] {
    const n = Math.max(1, Math.min(HISTORY_LIMIT, Math.floor(limit)));
    return this.history.slice(-n).reverse();
  }

  /** 同一首歌在去重窗口内是否已经点过（含正在播/已播完）。 */
  private isDuplicate(songId: string, now: number): boolean {
    const windowMs = this.options.duplicateWindowSec * 1000;
    if (windowMs <= 0) return false;
    return this.history.some(
      (item) => item.song?.id === songId && item.status !== 'failed' && now - item.createdAt < windowMs,
    );
  }

  /** 同一用户是否还在冷却期（只算被接受的请求）。 */
  private isCoolingDown(user: string, now: number): boolean {
    const windowMs = this.options.perUserCooldownSec * 1000;
    if (windowMs <= 0) return false;
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      const item = this.history[i] as SongRequest;
      if (item.user !== user) continue;
      if (now - item.createdAt < windowMs) return true;
      break; // 只比对最近一条
    }
    return false;
  }

  /** 用户在一小时内被接受过几首。 */
  private countUserInWindow(user: string, now: number, windowMs: number): number {
    let count = 0;
    for (const item of this.history) {
      if (item.user !== user) continue;
      if (now - item.createdAt < windowMs) count += 1;
    }
    return count;
  }

  /** 记进历史并裁剪。 */
  private record(item: SongRequest): void {
    this.history.push(item);
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
  }
}
