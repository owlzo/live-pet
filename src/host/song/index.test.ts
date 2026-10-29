/**
 * 点歌服务单测：从弹幕指令到状态机推进的整条链路，适配器与时钟全部注入。
 *
 * 覆盖四段：解析 → 搜索 → 守卫 → 队列/状态机。真实客户端与网络都不参与，
 * 因此这些断言测的是「我们的编排对不对」，不是「网易云能不能用」（那属于联调）。
 * @module live-pet/src/host/song/index.test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSongService, normalizeSongConfig, titleMatchesSong, type SongService } from './index.ts';
import type { NeteaseAdapter } from './netease.ts';
import { DEFAULT_SONG_CONFIG, type SongCandidate } from './types.ts';

/** 静默日志：单测里不需要噪声。 */
const log = { info: (): void => undefined, warn: (): void => undefined };

/** 造一首候选。 */
function candidate(over: Partial<SongCandidate> = {}): SongCandidate {
  return { id: '168091', title: '蓝莲花', artist: '许巍', durationMs: 240_000, ...over };
}

/** 假适配器：所有外部副作用都收在这里，便于断言「投了几次、投给了谁」。 */
function makeFake(): {
  adapter: NeteaseAdapter;
  state: {
    running: boolean;
    title: string;
    played: string[];
    autoTitle: boolean;
    candidates: SongCandidate[];
    searched: string[];
  };
} {
  const state = {
    running: true,
    title: '',
    played: [] as string[],
    autoTitle: true,
    candidates: [candidate()],
    searched: [] as string[],
  };
  const adapter: NeteaseAdapter = {
    async search(keyword: string): Promise<SongCandidate[]> {
      state.searched.push(keyword);
      return state.candidates;
    },
    async play(songId: string): Promise<void> {
      state.played.push(songId);
      if (state.autoTitle) state.title = `${state.candidates[0]?.title ?? ''} - ${state.candidates[0]?.artist ?? ''}`;
    },
    async probe() {
      return { running: state.running, title: state.title };
    },
    async resolveExePath() {
      return undefined;
    },
    async launch() {
      return false;
    },
  };
  return { adapter, state };
}

/** 建一个测试用服务（临时配置目录 + 注入时钟）。 */
function makeService(): {
  song: SongService;
  state: ReturnType<typeof makeFake>['state'];
  said: string[];
  clock: { t: number };
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'live-pet-song-'));
  const { adapter, state } = makeFake();
  const said: string[] = [];
  const clock = { t: 1000 };
  const song = createSongService({
    log,
    configPath: join(dir, 'song-config.json'),
    adapter,
    now: () => clock.t,
    tickMs: 60_000,
    announce: (text) => said.push(text),
  });
  song.updateConfig({
    enabled: true,
    accepting: true,
    guard: {
      mode: 'fail-open',
      whitelistSongIds: [],
      blacklistSongIds: [],
      blacklistArtists: [],
      bannedWords: [],
      rejectOverSec: 600,
    },
    queue: { maxPending: 10, perUserCooldownSec: 0, perUserMaxPerHour: 100, duplicateWindowSec: 0 },
    playback: { playLimitSec: 0, verifyDelayMs: 200, pollIntervalMs: 200, tailMs: 0 },
    announce: { enabled: true, delayMs: 0 },
    netease: { exePath: '', autoLaunch: false, launchMinimized: true, commandGapMs: 0 },
  });
  return {
    song,
    state,
    said,
    clock,
    cleanup: () => {
      song.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('普通弹幕不拦截：不是点歌指令就交回原流程', async () => {
  const { song, cleanup } = makeService();
  try {
    assert.equal(await song.handleChat('小明', '主播好呀'), undefined);
    assert.equal(await song.handleChat('小明', '我点歌单里的歌都听腻了'), undefined);
  } finally {
    cleanup();
  }
});

test('功能关闭时点歌指令当普通弹幕，不改变既有行为', async () => {
  const { song, cleanup } = makeService();
  try {
    song.updateConfig({ enabled: false });
    assert.equal(await song.handleChat('小明', '点歌 蓝莲花'), undefined);
    const outcome = await song.request({ user: '小明', text: '点歌 蓝莲花' });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'disabled');
  } finally {
    cleanup();
  }
});

test('搜不到：给出可理解的提示，不入队', async () => {
  const { song, state, cleanup } = makeService();
  try {
    state.candidates = [];
    const outcome = await song.request({ user: '小明', text: '点歌 不存在的歌' });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'not-found');
    assert.match(outcome.message, /没找到/);
    assert.equal(song.status().pending.length, 0);
  } finally {
    cleanup();
  }
});

test('守卫拦截：命中敏感词时拒绝，且不入队', async () => {
  const { song, state, cleanup } = makeService();
  try {
    state.candidates = [candidate({ title: '禁歌', id: '999' })];
    song.updateConfig({ guard: { ...DEFAULT_SONG_CONFIG.guard, bannedWords: ['禁歌'] } });
    const outcome = await song.request({ user: '小明', text: '点歌 禁歌' });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'banned-word');
    assert.match(outcome.message, /不能播/);
    assert.equal(song.status().pending.length, 0);
  } finally {
    cleanup();
  }
});

test('入队成功：返回排位文案，队列里能看到那一条', async () => {
  const { song, cleanup } = makeService();
  try {
    const first = await song.request({ user: '小明', text: '点歌 蓝莲花' });
    assert.equal(first.ok, true);
    assert.match(first.message, /马上播放/);

    const second = await song.request({ user: '小红', text: '点歌 起风了' });
    assert.equal(second.ok, true);
    assert.match(second.message, /排第 2 位/);
    assert.equal(song.status().pending.length, 2);
  } finally {
    cleanup();
  }
});

test('状态机：投递 → 确认 → 计时 → 播完推进', async () => {
  const { song, state, said, clock, cleanup } = makeService();
  try {
    await song.request({ user: '小明', text: '点歌 蓝莲花' });

    await song.tick(); // 开始这一首（报幕）
    await song.tick(); // 投递
    assert.deepEqual(state.played, ['168091'], '投递一次');
    assert.equal(song.status().playing?.status, 'requesting');

    clock.t += 300;
    await song.tick(); // 确认播放
    assert.equal(song.status().playing?.status, 'playing');
    assert.ok(said.some((text) => text.includes('接下来播放')), '开播前要报幕');

    clock.t += 240_000 + 10;
    await song.tick(); // 到时收尾
    assert.equal(song.status().playing, null);
    assert.equal(song.status().counts.played, 1);
  } finally {
    cleanup();
  }
});

test('投递后没切歌：重投一次，仍不行则跳过并计入失败', async () => {
  const { song, state, clock, cleanup } = makeService();
  try {
    state.autoTitle = false; // 客户端没任何反应（无版权/未登录时就是这样）
    await song.request({ user: '小明', text: '点歌 蓝莲花' });

    await song.tick(); // 开始
    await song.tick(); // 第一次投递
    clock.t += 300;
    await song.tick(); // 确认失败 → 重投
    await song.tick(); // 第二次投递
    clock.t += 300;
    await song.tick(); // 仍失败 → 跳过

    assert.equal(state.played.length, 2, '最多重投一次');
    assert.equal(song.status().playing, null);
    assert.equal(song.status().counts.failed, 1);
  } finally {
    cleanup();
  }
});

test('切歌：手动 skip 结束当前这首，队列继续', async () => {
  const { song, cleanup } = makeService();
  try {
    await song.request({ user: '小明', text: '点歌 蓝莲花' });
    await song.tick();
    await song.tick();
    assert.notEqual(song.status().playing, null);
    assert.equal(song.skip(), true);
    assert.equal(song.status().playing, null, 'skip 后当前置空');
    assert.equal(song.skip(), false, '没有在播时返回 false');
  } finally {
    cleanup();
  }
});

test('防刷：同一用户 3 秒内第二次尝试直接冷却', async () => {
  const { song, cleanup } = makeService();
  try {
    await song.request({ user: '小明', text: '点歌 蓝莲花' });
    const again = await song.request({ user: '小明', text: '点歌 另一首' });
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'cooldown');
  } finally {
    cleanup();
  }
});

test('手工点歌传整句时先解析：搜索词里不该带「点歌」两个字', async () => {
  const { song, state, cleanup } = makeService();
  try {
    await song.request({ user: '主播', text: '点歌 蓝莲花' });
    assert.deepEqual(state.searched, ['蓝莲花'], '整句要先解析成检索词');
  } finally {
    cleanup();
  }
});

test('投递前二次复核：排队期间被拉黑就不放了', async () => {
  const { song, state, said, cleanup } = makeService();
  try {
    await song.request({ user: '小明', text: '点歌 蓝莲花' }); // fail-open 放行入队
    assert.equal(song.status().pending.length, 1);

    // 排队期间主播把这首加进黑名单，并切到严格模式
    song.updateConfig({ guard: { ...DEFAULT_SONG_CONFIG.guard, mode: 'fail-closed', blacklistSongIds: ['168091'] } });

    await song.tick(); // 开始（报幕）
    await song.tick(); // 投递前复核 → 拦下，不投递

    assert.deepEqual(state.played, [], '一次都不该投递给客户端');
    assert.equal(song.status().counts.failed, 1);
    assert.ok(said.some((text) => text.includes('不可播')), '要告诉观众为什么跳过');
  } finally {
    cleanup();
  }
});

test('客户端不可用：先失败一次并整体退避，不把队列烧光', async () => {
  const { song, state, clock, cleanup } = makeService();
  try {
    state.running = false; // 探测为 false，launch 也返回 false
    await song.request({ user: '小明', text: '点歌 蓝莲花' });
    await song.tick(); // 开始这一首
    await song.tick(); // 确保客户端 → 失败 → 判 no-client

    assert.equal(song.status().counts.failed, 1);
    assert.equal(song.status().playing, null);

    state.candidates = [candidate({ id: '2', title: '起风了' })];
    await song.request({ user: '小红', text: '点歌 起风了' });
    assert.equal(song.status().pending.length, 1);

    clock.t += 1000;
    await song.tick(); // 退避中：不该取歌
    assert.equal(song.status().pending.length, 1, '退避期内队列不动');
    assert.equal(state.played.length, 0, '一次都不该投递');
  } finally {
    cleanup();
  }
});

test('标题匹配：归一化后包含即算命中，空标题永远不命中', () => {
  assert.equal(titleMatchesSong('蓝莲花 - 许巍', candidate()), true);
  assert.equal(titleMatchesSong('  蓝莲花(Live) - 许巍', candidate()), true);
  assert.equal(titleMatchesSong('起风了 - 冯沁苑', candidate()), false);
  assert.equal(titleMatchesSong('', candidate()), false);
});

test('配置收敛：嵌套字段缺一项不会被整段打回默认', () => {
  const normalized = normalizeSongConfig({ enabled: true, guard: { mode: 'fail-open' } }, DEFAULT_SONG_CONFIG);
  assert.equal(normalized.enabled, true);
  assert.equal(normalized.guard.mode, 'fail-open');
  assert.deepEqual(normalized.guard.blacklistArtists, [], '同段其他字段回落默认');
  assert.equal(normalized.queue.maxPending, DEFAULT_SONG_CONFIG.queue.maxPending);
});
