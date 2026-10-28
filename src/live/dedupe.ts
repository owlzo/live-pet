/**
 * 重复事件抑制：同一用户 + 同一内容在时间窗内只放行前 N 次，其余丢弃并计数。
 *
 * 不做「同类合并」——每一条放行的事件仍然独立触发动作，只是刷屏的重复内容会被压掉。
 * 键 = 类型 + 用户 + 内容（弹幕取正文、礼物取礼物名），窗口到期自动重置，无需外部清理。
 * 必须始终成立：只读事件、不改事件；now 由调用方注入，便于单测。
 * @module live-pet/src/live/dedupe
 */
import type { DedupeOptions, LiveEvent } from './types.ts';

/** 一条去重记录：窗口内的放行次数与重置时刻。 */
interface Hit {
  /** 本窗口内已放行次数。 */
  count: number;
  /** 窗口到期时刻（毫秒）；到期后计数归零。 */
  resetAt: number;
}

/** 事件 → 去重键；内容缺失时退化成「类型 + 用户」（例如进场、点赞）。 */
export function dedupeKey(event: LiveEvent): string {
  const content = event.kind === 'gift' ? (event.giftName ?? '') : (event.text ?? '');
  // 用 \\u0000 分隔，避免「用户A + 内容B」与「用户AB + 内容」撞键
  return event.kind + '\u0000' + event.user + '\u0000' + content;
}

/** 重复事件抑制器（进程内内存态，重启即空）。 */
export class Deduper {
  private readonly hits = new Map<string, Hit>();
  private suppressed = 0;
  /** 去重参数（窗口长度与放行上限）。 */
  private readonly options: DedupeOptions;

  constructor(options: DedupeOptions) {
    this.options = options;
  }

  /**
   * 判定一条事件是否放行。
   *
   * @param event - 归一化事件。
   * @param now - 当前时间（毫秒），单测注入。
   * @returns true = 放行（计数 +1）；false = 抑制（抑制数 +1）。
   */
  admit(event: LiveEvent, now = Date.now()): boolean {
    const key = dedupeKey(event);
    const hit = this.hits.get(key);
    if (hit === undefined || now >= hit.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.options.windowMs });
      return true;
    }
    if (hit.count < this.options.maxPerWindow) {
      hit.count += 1;
      return true;
    }
    this.suppressed += 1;
    return false;
  }

  /** 累计被抑制的条数。 */
  suppressedCount(): number {
    return this.suppressed;
  }

  /** 当前仍占用的键数量（观测用：验证窗口过期后不会无限增长）。 */
  size(now = Date.now()): number {
    let live = 0;
    for (const hit of this.hits.values()) if (now < hit.resetAt) live += 1;
    return live;
  }

  /** 清空全部计数（重连 / 换房间时调用）。 */
  reset(): void {
    this.hits.clear();
    this.suppressed = 0;
  }

  /** 清掉已过期的键，避免长时间直播把 Map 撑大；按分钟级调用即可。 */
  prune(now = Date.now()): void {
    for (const [key, hit] of this.hits) {
      if (now >= hit.resetAt) this.hits.delete(key);
    }
  }
}
