/**
 * 外部转发器的载荷归一化：把 HTTP POST 过来的 JSON 转成 LiveEvent。
 *
 * 兼容 cyber-xiaoya-danmaku 的字段（nick / content / kind / gift_item / gift_num），
 * 同时接受常见别名（nickname / text / giftName / count），方便换其它中间件。
 * 只做映射，不做去重与动作（分别归 ./index 与 ./handlers）。
 * @module live-pet/src/live/ingest
 */
import type { LiveEvent, LiveEventKind } from './types.ts';

/** 按候选键取第一个非空字符串（对象/数组一律忽略，避免把嵌套结构拼进昵称）。 */
function pickString(o: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = o[key];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

/** 按候选键取第一个正数。 */
function pickNumber(o: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const n = Number(o[key]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

/**
 * 外部载荷 → LiveEvent。
 *
 * 认不出（缺正文的弹幕 / 缺礼物名的礼物）返回 null，由路由回 400，不静默吞掉。
 *
 * @param raw - 已解析的请求体。
 * @returns 归一化事件；结构不可用时为 null。
 */
export function normalizeExternal(raw: unknown): LiveEvent | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const tag = (pickString(o, ['kind', 'type', 'event', 'msgType']) ?? 'chat').toLowerCase();
  let kind: LiveEventKind = 'chat';
  if (tag.includes('gift')) kind = 'gift';
  else if (tag.includes('enter') || tag.includes('join')) kind = 'enter';
  else if (tag.includes('follow')) kind = 'follow';
  else if (tag.includes('like') || tag.includes('digg')) kind = 'like';

  const user = pickString(o, ['nick', 'nickname', 'userName', 'user', 'from', 'uname']) ?? '匿名';
  const text = pickString(o, ['content', 'text', 'msg', 'message', 'danmaku']);
  const giftName = pickString(o, ['gift_item', 'giftName', 'gift_name', 'gift', 'giftItem']);
  const giftCount = pickNumber(o, ['gift_num', 'giftCount', 'gift_count', 'count', 'num']) ?? 1;

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
