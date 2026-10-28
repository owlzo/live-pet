/**
 * 互动队列：把「收到就立刻播」改成「先缓冲、按比例抽样、再按到达顺序一句一句播」。
 *
 * 为什么需要它：直播间一热闹，弹幕是按秒涌进来的。之前每条都立刻写 say 叶子，气泡和语音互相覆盖，
 * 结果是「看起来根本没读完」——被后来的顶掉了。这里把「到达」和「播报」解耦：
 *
 *   到达 ──▶ 缓冲（礼物直接进待播，其它进抽样批） ──▶ 抽样决策 ──▶ 待播队列 ──▶ 逐条出队播报
 *
 * 三条硬规则（都是需求方明确要求的）：
 * 1. **礼物必谢**：礼物不进抽样批，直接进待播队列，永远不会因为抽样被丢掉。
 * 2. **保持先后**：抽样只决定「谁留下」，留下的仍按到达顺序出队，不重排、不插队。
 * 3. **不无限堆积**：待播队列有上限（默认 50），满了丢最旧的——宁可少播旧的，也要让新的能播。
 *
 * 不负责计时与播报：什么时候该出队、每条播多久归调用方（`src/live/index.ts`）。
 * 不负责去重：同一用户同一内容的重复在这里之前就被 Deduper 挡掉了。
 * @module live-pet/src/live/queue
 */
import type { LiveEvent } from './types.ts';

/** 一条互动在队列里的生命周期状态（控制台直接按这个渲染）。 */
export type InteractionStatus =
  /** 在抽样批里，等这一批攒够 / 到点后一起决策。 */
  | 'pending'
  /** 已决定要播，排在待播队列里。 */
  | 'queued'
  /** 已经播出去了。 */
  | 'played'
  /** 没播：被抽样刷掉，或队列满了被挤掉。 */
  | 'dropped';

/** 丢弃原因（控制台展示用，别让用户猜为什么少了几条）。 */
export type DropReason = 'sampled-out' | 'queue-full';

/** 队列里的一条互动。 */
export interface QueuedInteraction {
  /** 自增序号，仅用于控制台稳定渲染 key 与「谁先谁后」。 */
  readonly id: number;
  /** 归一化后的原始事件。 */
  readonly event: LiveEvent;
  /** 收到时刻（毫秒）。 */
  readonly receivedAt: number;
  /** 当前状态。 */
  status: InteractionStatus;
  /** 播出去的毫秒时间戳（status = played 时才有）。 */
  playedAt?: number;
  /** 没播的原因（status = dropped 时才有）。 */
  dropReason?: DropReason;
}

/** 队列参数（全部可在控制台改）。 */
export interface InteractionQueueOptions {
  /** 待播队列上限；同时也是抽样批的批量：攒够这么多就决策一次。 */
  maxPending: number;
  /** 抽样比例 0~1：一批里留下多少。1 = 全留，0 = 全丢（礼物除外）。 */
  sampleRatio: number;
  /** 抽样批最多等这么久（毫秒）就强制决策一次，避免小房间攒不满一直不播。 */
  flushMs: number;
  /** 历史保留条数（控制台「互动记录」看的就是这份）。 */
  historyLimit: number;
}

/** 默认参数：50 条一批、随机留一半、最多等 3 秒。 */
export const DEFAULT_QUEUE_OPTIONS: InteractionQueueOptions = {
  maxPending: 50,
  sampleRatio: 0.5,
  flushMs: 3000,
  historyLimit: 200,
};

/** 数字收敛到 [min, max]（配置来自外部，一律当作不可信输入）。 */
function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * 估算「这条念完要多久」（毫秒）。
 *
 * 语音时长拿不到（合成在另一个进程、还是流式的），所以按字数估：中文正常语速约 5~6 字/秒，
 * 加上固定开销（起播、句末停顿）。估长了只是节奏慢一点，估短了会互相打断——所以宁可偏长。
 *
 * @param text - 要播的文本（礼物感谢语等由调用方拼好）。
 * @returns 毫秒，已收敛到 [1200, 15000]。
 */
export function estimateSpeechMs(text: string): number {
  const chars = text.length;
  const ms = 400 + chars * 180;
  return Math.max(1200, Math.min(15000, ms));
}

/** 队列的运行计数（控制台「收到 / 放行 / 抑制」之外还要看抽样丢了多少）。 */
export interface QueueStats {
  /** 待播队列长度。 */
  queued: number;
  /** 抽样批里还没决策的条数。 */
  batch: number;
  /** 已播报条数。 */
  played: number;
  /** 被抽样刷掉的条数。 */
  droppedSampled: number;
  /** 因队列满被挤掉的条数。 */
  droppedQueueFull: number;
}

/**
 * 互动队列。
 *
 * 纯内存、进程内、无定时器：`flush` 由调用方按拍子驱动，方便单测与复用。
 */
export class InteractionQueue {
  private options: InteractionQueueOptions;
  private readonly rng: () => number;
  private seq = 0;
  /** 抽样批：非礼物互动，攒够或到点后一起决策。 */
  private batch: QueuedInteraction[] = [];
  /** 待播队列：已决定要播，按到达顺序排队。 */
  private ready: QueuedInteraction[] = [];
  /** 全部记录（含已播/已丢），尾部最新，长度受 historyLimit 限制。 */
  private log: QueuedInteraction[] = [];
  /** 上一次抽样决策的时刻（毫秒）。 */
  private lastFlushAt = 0;
  /** 已播报条数（控制台展示用）。 */
  private playedCount = 0;
  /** 被抽样刷掉的条数。 */
  private droppedSampled = 0;
  /** 因队列满被挤掉的条数。 */
  private droppedQueueFull = 0;

  /**
   * @param options - 初始参数（缺省见 {@link DEFAULT_QUEUE_OPTIONS}）。
   * @param rng - 随机源，注入是为了让抽样在单测里可复现。
   */
  constructor(options: Partial<InteractionQueueOptions> = {}, rng: () => number = Math.random) {
    this.options = normalizeOptions({ ...DEFAULT_QUEUE_OPTIONS, ...options });
    this.rng = rng;
  }

  /** 当前参数（拷贝，外部改不到内部状态）。 */
  getOptions(): InteractionQueueOptions {
    return { ...this.options };
  }

  /** 改参数（运行中生效；只影响之后的抽样决策，已在队列里的不动）。 */
  setOptions(patch: Partial<InteractionQueueOptions>): InteractionQueueOptions {
    this.options = normalizeOptions({ ...this.options, ...patch });
    return { ...this.options };
  }

  /**
   * 收到一条互动。
   *
   * 礼物直接进待播队列（必谢），其余进抽样批等决策。
   *
   * @param event - 归一化后的事件。
   * @param now - 当前时刻（毫秒），由调用方注入便于测试。
   * @returns 刚记录下来的那一条（状态可能是 pending / queued / dropped）。
   */
  push(event: LiveEvent, now: number): QueuedInteraction {
    const item: QueuedInteraction = {
      id: ++this.seq,
      event,
      receivedAt: now,
      status: 'pending',
    };
    this.log.push(item);
    if (this.log.length > this.options.historyLimit) this.log.splice(0, this.log.length - this.options.historyLimit);

    if (event.kind === 'gift') {
      // 礼物必谢：不进抽样批，直接排队
      this.enqueue(item);
    } else {
      this.batch.push(item);
      // 攒够了就立刻决策，不必等到下一拍
      if (this.batch.length >= this.options.maxPending) this.flush(now, true);
    }
    return item;
  }

  /**
   * 手工注入一条互动：不进抽样批，直接排到待播队列末尾。
   *
   * 用于控制台「模拟事件」和其它平台适配层——手工点的必须立刻可见，
   * 否则用户点一下要等 3 秒才看到气泡，会以为坏了。
   *
   * @param event - 归一化后的事件。
   * @param now - 当前时刻（毫秒）。
   * @returns 恒为 true（入队必成功；队列满时挤掉的是最旧的一条）。
   */
  pushNow(event: LiveEvent, now: number): boolean {
    const item: QueuedInteraction = {
      id: ++this.seq,
      event,
      receivedAt: now,
      status: 'pending',
    };
    this.log.push(item);
    if (this.log.length > this.options.historyLimit) this.log.splice(0, this.log.length - this.options.historyLimit);
    this.enqueue(item);
    return true;
  }

  /**
   * 抽样决策：从当前批里按比例随机留一批，按原顺序放进待播队列。
   *
   * @param now - 当前时刻（毫秒）。
   * @param force - true = 不管攒没攒够都决策；false = 攒够 maxPending 或超过 flushMs 才决策。
   * @returns 本次决策放行了几条（0 表示没到点、没决策）。
   */
  flush(now: number, force = false): number {
    if (this.batch.length === 0) return 0;
    const due = force || this.batch.length >= this.options.maxPending || now - this.lastFlushAt >= this.options.flushMs;
    if (!due) return 0;

    const batch = this.batch;
    this.batch = [];
    this.lastFlushAt = now;

    const keep = this.pickCount(batch.length);
    if (keep >= batch.length) {
      // 全留：顺序天然正确，不必洗牌
      for (const item of batch) this.enqueue(item);
      return batch.length;
    }

    const chosen = this.pickIndices(batch.length, keep);
    let admitted = 0;
    for (let i = 0; i < batch.length; i += 1) {
      const item = batch[i];
      if (chosen.has(i)) {
        this.enqueue(item);
        admitted += 1;
      } else {
        item.status = 'dropped';
        item.dropReason = 'sampled-out';
        this.droppedSampled += 1;
      }
    }
    return admitted;
  }

  /**
   * 取下一条要播的互动（FIFO）。取到即标记为 played。
   *
   * @param now - 当前时刻（毫秒）。
   * @returns 待播的那条；队列空时 undefined。
   */
  take(now: number): QueuedInteraction | undefined {
    const item = this.ready.shift();
    if (item === undefined) return undefined;
    item.status = 'played';
    item.playedAt = now;
    this.playedCount += 1;
    return item;
  }

  /** 待播队列长度（调用方据此判断「还有多少要念」）。 */
  get pendingCount(): number {
    return this.ready.length;
  }

  /** 抽样批里还没决策的条数。 */
  get batchCount(): number {
    return this.batch.length;
  }

  /** 抽样批里最早一条的到达时刻（没有则 undefined）；调用方用来判断该不该到点冲刷。 */
  get oldestBatchAt(): number | undefined {
    return this.batch[0]?.receivedAt;
  }

  /** 运行计数（控制台展示，只增不减，reset 时归零）。 */
  stats(): QueueStats {
    return {
      queued: this.ready.length,
      batch: this.batch.length,
      played: this.playedCount,
      droppedSampled: this.droppedSampled,
      droppedQueueFull: this.droppedQueueFull,
    };
  }

  /**
   * 历史记录（最新在前）。
   *
   * @param limit - 最多返回几条（默认 100，上限 historyLimit）。
   */
  history(limit = 100): QueuedInteraction[] {
    const n = Math.max(1, Math.min(this.options.historyLimit, Math.floor(limit)));
    return this.log.slice(-n).reverse();
  }

  /** 清空队列与历史（重新连接直播间时用，避免上一场的残留串进来）。 */
  reset(): void {
    this.batch = [];
    this.ready = [];
    this.log = [];
    this.lastFlushAt = 0;
    this.playedCount = 0;
    this.droppedSampled = 0;
    this.droppedQueueFull = 0;
  }

  /** 按比例算这一批该留几条：至少 0，最多全留；比例 > 0 但算出来是 0 时，给 1 条保底。 */
  private pickCount(total: number): number {
    const ratio = this.options.sampleRatio;
    if (ratio >= 1) return total;
    if (ratio <= 0) return 0;
    const n = Math.round(total * ratio);
    // 保底：来了一条弹幕、比例又大于 0，结果一条都不播，观感上像「坏了」
    return n === 0 && total > 0 ? 1 : Math.min(n, total);
  }

  /** 从 [0, total) 里随机挑 count 个下标（部分洗牌，O(count)）。 */
  private pickIndices(total: number, count: number): Set<number> {
    const pool = Array.from({ length: total }, (_, i) => i);
    for (let i = 0; i < count; i += 1) {
      const j = i + Math.floor(this.rng() * (pool.length - i));
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }
    return new Set(pool.slice(0, count));
  }

  /** 放进待播队列；超上限时挤掉最旧的一条（标记 queue-full）。 */
  private enqueue(item: QueuedInteraction): void {
    item.status = 'queued';
    item.dropReason = undefined;
    this.ready.push(item);
    while (this.ready.length > this.options.maxPending) {
      const dropped = this.ready.shift();
      if (dropped === undefined) break;
      dropped.status = 'dropped';
      dropped.dropReason = 'queue-full';
      dropped.playedAt = undefined;
      this.droppedQueueFull += 1;
    }
  }
}

/** 参数收敛：全部字段都夹到合法区间，坏值一律回落默认值。 */
function normalizeOptions(options: InteractionQueueOptions): InteractionQueueOptions {
  return {
    maxPending: Math.round(clamp(options.maxPending, 1, 500, DEFAULT_QUEUE_OPTIONS.maxPending)),
    sampleRatio: clamp(options.sampleRatio, 0, 1, DEFAULT_QUEUE_OPTIONS.sampleRatio),
    flushMs: Math.round(clamp(options.flushMs, 200, 60000, DEFAULT_QUEUE_OPTIONS.flushMs)),
    historyLimit: Math.round(clamp(options.historyLimit, 20, 1000, DEFAULT_QUEUE_OPTIONS.historyLimit)),
  };
}
