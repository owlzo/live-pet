/**
 * 直播接入路由：状态、配置、连接/断开、测试事件。
 *
 * 只做参数校验与转发；连接与去重都在 ../live。
 * 必须始终成立：未知事件类型回 400，不静默吞掉调用方的错误。
 * @module live-pet/src/host/routes/live
 */
import { okResult, failResult, invalidJson, methodNotAllowed } from './result.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';
import type { LiveEventKind } from '../../live/types.ts';
import { normalizeExternal } from '../../live/ingest.ts';

/** 允许注入的测试事件类型。 */
const KINDS: readonly LiveEventKind[] = ['chat', 'gift', 'enter', 'like', 'follow'];

/** 直播领域路由：未命中返回 undefined。 */
export async function handleLiveRoutes(deps: PetRouteDeps, input: RouteInput): Promise<ReturnType<typeof okResult> | undefined> {
  const { rest, method, body } = input;

  if (rest === 'live/status') {
    if (method !== 'GET') return methodNotAllowed();
    return okResult(deps.live.status());
  }

  if (rest === 'live/config') {
    if (method === 'GET') return okResult(deps.live.config());
    if (method !== 'POST') return methodNotAllowed();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body ?? 'null');
    } catch {
      return invalidJson();
    }
    if (!parsed || typeof parsed !== 'object') return failResult('bad-request', 'expected object');
    const o = parsed as Record<string, unknown>;
    return okResult(
      deps.live.updateConfig({
        ...(typeof o.sourceUrl === 'string' ? { sourceUrl: o.sourceUrl } : {}),
        ...(typeof o.room === 'string' ? { room: o.room } : {}),
        ...(typeof o.dedupeWindowSec === 'number' ? { dedupeWindowSec: o.dedupeWindowSec } : {}),
        ...(typeof o.dedupeMaxPerWindow === 'number' ? { dedupeMaxPerWindow: o.dedupeMaxPerWindow } : {}),
      }),
    );
  }

  if (rest === 'live/connect') {
    if (method !== 'POST') return methodNotAllowed();
    let room: string | undefined;
    if (body !== undefined && body !== '') {
      try {
        const parsed = JSON.parse(body) as { room?: unknown };
        if (typeof parsed?.room === 'string') room = parsed.room;
      } catch {
        return invalidJson();
      }
    }
    deps.live.connect(room);
    return okResult(deps.live.status());
  }

  if (rest === 'live/disconnect') {
    if (method !== 'POST') return methodNotAllowed();
    deps.live.disconnect();
    return okResult(deps.live.status());
  }

  // 外部转发器的入口：cyber-xiaoya-danmaku 等中间件直接 POST 到这里（无 Origin，本机）。
  if (rest === 'live/ingest') {
    if (method !== 'POST') return methodNotAllowed();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body ?? 'null');
    } catch {
      return invalidJson();
    }
    const event = normalizeExternal(parsed);
    if (event === null) {
      return failResult('bad-request', '无法识别的事件：弹幕需要 content/text，礼物需要 gift_item');
    }
    return okResult({ admitted: deps.live.inject(event) });
  }

  if (rest === 'live/test') {
    if (method !== 'POST') return methodNotAllowed();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body ?? 'null');
    } catch {
      return invalidJson();
    }
    const o = (parsed ?? {}) as Record<string, unknown>;
    const kind = String(o.kind ?? 'chat') as LiveEventKind;
    if (!KINDS.includes(kind)) return failResult('bad-request', 'kind 必须是 chat/gift/enter/like/follow');
    const admitted = deps.live.inject({
      kind,
      user: typeof o.user === 'string' && o.user !== '' ? o.user : '测试观众',
      ...(typeof o.text === 'string' ? { text: o.text } : {}),
      ...(typeof o.giftName === 'string' ? { giftName: o.giftName } : {}),
      ...(typeof o.giftCount === 'number' ? { giftCount: o.giftCount } : {}),
      ts: Date.now(),
    });
    return okResult({ admitted });
  }

  return undefined;
}
