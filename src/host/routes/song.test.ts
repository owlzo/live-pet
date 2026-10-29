/**
 * 点歌路由单测：路径分发、方法与参数校验、失败形状。
 *
 * 路由只做转发，所以这里用一个最小 stub 服务——校验的是「参数不合法时有没有如实报错」，
 * 业务行为由 `../song/index.test.ts` 覆盖。
 * @module live-pet/src/host/routes/song.test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleSongRoutes } from './song.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';
import type { SongService, SongStatusView } from '../song/index.ts';
import { DEFAULT_SONG_CONFIG, type SongConfig, type SongRequest } from '../song/types.ts';

/** 空状态。 */
function status(): SongStatusView {
  return {
    enabled: false,
    accepting: true,
    playing: null,
    pending: [],
    counts: { accepted: 0, played: 0, failed: 0, rejected: 0 },
    client: { running: false, title: '' },
  };
}

/** 最小 stub：只实现路由会用到的成员。 */
function makeDeps(): { deps: PetRouteDeps; calls: string[]; removed: number[] } {
  const calls: string[] = [];
  const removed: number[] = [];
  const service: SongService = {
    status,
    config: (): SongConfig => ({ ...DEFAULT_SONG_CONFIG }),
    updateConfig: (patch: unknown): SongConfig => {
      calls.push('config');
      return { ...DEFAULT_SONG_CONFIG, ...(patch as Partial<SongConfig>) };
    },
    handleChat: async () => undefined,
    request: async (input) => {
      calls.push(`request:${input.user}:${input.text}`);
      return { ok: true, message: '收到', request: undefined };
    },
    skip: () => {
      calls.push('skip');
      return true;
    },
    remove: (id: number) => {
      removed.push(id);
      return true;
    },
    clear: () => 0,
    search: async (keyword) => {
      calls.push(`search:${keyword}`);
      return [];
    },
    ensureClient: async () => true,
    history: (): SongRequest[] => [],
    tick: async () => undefined,
    dispose: () => undefined,
  };
  return { deps: { song: service } as unknown as PetRouteDeps, calls, removed };
}

/** 造一次路由输入。 */
function input(rest: string, method = 'GET', body?: string, query = ''): RouteInput {
  return {
    url: new URL(`http://localhost/live-pet/${rest}${query}`),
    rest,
    method,
    ...(body === undefined ? {} : { body }),
  };
}

test('非点歌路径不认领', async () => {
  const { deps } = makeDeps();
  assert.equal(await handleSongRoutes(deps, input('live/status')), undefined);
});

test('GET /song/status 与 /song/config 直接返回', async () => {
  const { deps } = makeDeps();
  const st = await handleSongRoutes(deps, input('song/status'));
  assert.equal(st?.kind, 'json');
  assert.equal(st?.kind === 'json' ? st.status : 0, 200);

  const cfg = await handleSongRoutes(deps, input('song/config'));
  assert.equal(cfg?.kind === 'json' ? cfg.status : 0, 200);
});

test('POST /song/config 接受对象，坏 JSON 回 400', async () => {
  const { deps, calls } = makeDeps();
  const ok = await handleSongRoutes(deps, input('song/config', 'POST', '{"enabled":true}'));
  assert.equal(ok?.kind === 'json' ? ok.status : 0, 200);
  assert.deepEqual(calls, ['config']);

  const bad = await handleSongRoutes(deps, input('song/config', 'POST', '{oops'));
  assert.equal(bad?.kind === 'json' ? bad.status : 0, 400);
});

test('方法不对回 405', async () => {
  const { deps } = makeDeps();
  const res = await handleSongRoutes(deps, input('song/skip', 'GET'));
  assert.equal(res?.kind === 'json' ? res.status : 0, 405);
});

test('手工点歌：text 为空回 bad-request，非空转发给服务', async () => {
  const { deps, calls } = makeDeps();
  const empty = await handleSongRoutes(deps, input('song/queue', 'POST', '{"text":"  "}'));
  assert.equal(empty?.kind === 'json' ? (empty.obj as { ok: boolean }).ok : true, false);
  assert.deepEqual(calls, []);

  const ok = await handleSongRoutes(deps, input('song/queue', 'POST', '{"text":"点歌 蓝莲花","user":"小明"}'));
  assert.equal(ok?.kind === 'json' ? ok.status : 0, 200);
  assert.deepEqual(calls, ['request:小明:点歌 蓝莲花']);
});

test('删除：id 非法回 bad-request，合法时透传', async () => {
  const { deps, removed } = makeDeps();
  const bad = await handleSongRoutes(deps, input('song/remove', 'POST', '{"id":"x"}'));
  assert.equal(bad?.kind === 'json' ? bad.status : 0, 200);
  assert.equal(bad?.kind === 'json' ? (bad.obj as { reason?: string }).reason : '', 'bad-request');

  await handleSongRoutes(deps, input('song/remove', 'POST', '{"id":3}'));
  assert.deepEqual(removed, [3]);
});

test('搜索：缺 q 回业务失败（200 + bad-request），有 q 时转发', async () => {
  const { deps, calls } = makeDeps();
  const bad = await handleSongRoutes(deps, input('song/search'));
  // 缺参属于「请求已进入处理器」的业务结论：按仓库约定回 200 + 失败实体，不是 4xx
  assert.equal(bad?.kind === 'json' ? bad.status : 0, 200);
  assert.equal(bad?.kind === 'json' ? (bad.obj as { reason?: string }).reason : '', 'bad-request');

  const ok = await handleSongRoutes(deps, input('song/search', 'GET', undefined, '?q=蓝莲花'));
  assert.equal(ok?.kind === 'json' ? ok.status : 0, 200);
  assert.deepEqual(calls, ['search:蓝莲花']);
});

test('接单开关：只认布尔值', async () => {
  const { deps, calls } = makeDeps();
  const bad = await handleSongRoutes(deps, input('song/accepting', 'POST', '{"accepting":"yes"}'));
  assert.equal(bad?.kind === 'json' ? (bad.obj as { reason?: string }).reason : '', 'bad-request');

  await handleSongRoutes(deps, input('song/accepting', 'POST', '{"accepting":false}'));
  assert.deepEqual(calls, ['config']);
});
