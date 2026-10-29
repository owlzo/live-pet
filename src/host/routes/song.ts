/**
 * 点歌路由：状态、配置、队列、手工点歌、切歌/删除、曲库搜索与客户端拉起。
 *
 * 只做参数校验与转发；解析、判定、排队、播放都在 `../song`。
 * 必须始终成立：所有写操作都返回完整的生效结果（配置或状态），调用方不必再拉一次；
 * 参数非法时给出 `bad-request` 而不是静默忽略，否则控制台会以为保存成功了。
 * @module live-pet/src/host/routes/song
 */

import { failResult, invalidJson, methodNotAllowed, okResult } from './result.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';
import type { RouteResult } from '../http.ts';

/** 解析请求体：非对象一律 null。 */
function parseObject(body: string | undefined): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body ?? 'null');
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 点歌领域路由：未命中返回 undefined。 */
export async function handleSongRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  const { rest, method, body, url } = input;
  if (!rest.startsWith('song')) return undefined;
  const { song } = deps;

  if (rest === 'song/status') {
    if (method !== 'GET') return methodNotAllowed();
    return okResult(song.status());
  }

  if (rest === 'song/config') {
    if (method === 'GET') return okResult(song.config());
    if (method !== 'POST') return methodNotAllowed();
    const o = parseObject(body);
    if (o === null) return invalidJson();
    return okResult(song.updateConfig(o));
  }

  if (rest === 'song/queue') {
    if (method === 'GET') return okResult({ items: song.status().pending });
    if (method !== 'POST') return methodNotAllowed();
    const o = parseObject(body);
    if (o === null) return invalidJson();
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    if (text === '') return failResult('bad-request', 'text 不能为空');
    const user = typeof o.user === 'string' && o.user.trim() !== '' ? o.user.trim() : '主播';
    const outcome = await song.request({ user, text });
    return okResult({ ok: outcome.ok, message: outcome.message, ...(outcome.request ? { item: outcome.request } : {}) });
  }

  if (rest === 'song/skip') {
    if (method !== 'POST') return methodNotAllowed();
    return okResult({ skipped: song.skip(), status: song.status() });
  }

  if (rest === 'song/clear') {
    if (method !== 'POST') return methodNotAllowed();
    return okResult({ removed: song.clear(), status: song.status() });
  }

  if (rest === 'song/remove') {
    if (method !== 'POST') return methodNotAllowed();
    const o = parseObject(body);
    if (o === null) return invalidJson();
    const id = Number(o.id);
    if (!Number.isFinite(id) || id <= 0) return failResult('bad-request', 'id 必须是正整数');
    return okResult({ removed: song.remove(Math.floor(id)), status: song.status() });
  }

  if (rest === 'song/accepting') {
    if (method !== 'POST') return methodNotAllowed();
    const o = parseObject(body);
    if (o === null) return invalidJson();
    if (typeof o.accepting !== 'boolean') return failResult('bad-request', 'accepting 必须是布尔值');
    return okResult(song.updateConfig({ accepting: o.accepting }));
  }

  if (rest === 'song/search') {
    if (method !== 'GET') return methodNotAllowed();
    const q = (url.searchParams.get('q') ?? '').trim();
    if (q === '') return failResult('bad-request', 'q 不能为空');
    return okResult({ items: await song.search(q) });
  }

  if (rest === 'song/history') {
    if (method !== 'GET') return methodNotAllowed();
    const raw = Number(url.searchParams.get('limit') ?? '50');
    const limit = Number.isFinite(raw) ? Math.max(1, Math.min(200, Math.floor(raw))) : 50;
    return okResult({ items: song.history(limit) });
  }

  if (rest === 'song/launch') {
    if (method !== 'POST') return methodNotAllowed();
    return okResult({ running: await song.ensureClient(), status: song.status() });
  }

  return undefined;
}
