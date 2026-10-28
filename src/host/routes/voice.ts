/**
 * 语音路由：合成状态、配置、试听，以及把合成好的 mp3 发给桌面端。
 *
 * 只做参数校验与转发：合成、缓存、队列都在 ../voice。
 * 必须始终成立：文件名只认缓存命名（40 位十六进制 + .mp3），其它一律 404——这是本路由唯一的路径守卫。
 * @module live-pet/src/host/routes/voice
 */
import { okResult, failResult, invalidJson, methodNotAllowed } from './result.ts';
import type { RouteResult } from '../http.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';

/** 语音领域路由：未命中返回 undefined。 */
export async function handleVoiceRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  const { rest, method, body } = input;

  if (rest === 'voice/status') {
    if (method !== 'GET') return methodNotAllowed();
    return okResult(deps.voice.status());
  }

  if (rest === 'voice/config') {
    if (method === 'GET') return okResult(deps.voice.config());
    if (method !== 'POST') return methodNotAllowed();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body ?? 'null');
    } catch {
      return invalidJson();
    }
    if (!parsed || typeof parsed !== 'object') return failResult('bad-request', 'expected object');
    const o = parsed as Record<string, unknown>;
    // 每个字段各自校验：写错的字段直接不采纳，不因为一个坏值把整份配置打回
    return okResult(
      deps.voice.updateConfig({
        ...(typeof o.enabled === 'boolean' ? { enabled: o.enabled } : {}),
        ...(typeof o.voice === 'string' && o.voice !== '' ? { voice: o.voice } : {}),
        ...(typeof o.rate === 'number' ? { rate: o.rate } : {}),
        ...(typeof o.volume === 'number' ? { volume: o.volume } : {}),
        ...(typeof o.maxChars === 'number' ? { maxChars: o.maxChars } : {}),
      }),
    );
  }

  // 试听：当场合成一条，返回文件名；桌面端与浏览器都能用同一个地址播放。
  if (rest === 'voice/test') {
    if (method !== 'POST') return methodNotAllowed();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body ?? 'null');
    } catch {
      return invalidJson();
    }
    const o = (parsed ?? {}) as Record<string, unknown>;
    const text = typeof o.text === 'string' && o.text.trim() !== '' ? o.text : '你好呀，我是你的桌面宠物';
    const name = await deps.voice.synthesize(text);
    if (name === null) return failResult('tts-failed', '语音合成失败，检查网络或换一个音色再试');
    return okResult({ ok: true, name });
  }

  // 缓存音频：GET /voice/<40 位十六进制>.mp3
  if (rest.startsWith('voice/')) {
    if (method !== 'GET') return methodNotAllowed();
    const name = rest.slice('voice/'.length);
    const file = deps.voice.filePath(name);
    if (file === undefined) return { kind: 'text', status: 404, body: 'dsh-pet: voice not found' };
    return { kind: 'file', file, contentType: 'audio/mpeg' };
  }

  return undefined;
}
