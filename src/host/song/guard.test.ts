/**
 * 点歌守卫单测：判定顺序、黑名单优先于白名单、fail-closed / fail-open 的差别、配置收敛。
 *
 * 这里测的是「规则本身」，所以每条用例都直接把候选曲目与配置摆出来，不经过搜索。
 * @module live-pet/src/host/song/guard.test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeSong, normalizeGuardConfig } from './guard.ts';
import { DEFAULT_SONG_CONFIG, type SongCandidate, type SongGuardConfig } from './types.ts';

/** 造一首候选。 */
function song(over: Partial<SongCandidate> = {}): SongCandidate {
  return { id: '168091', title: '蓝莲花', artist: '许巍', durationMs: 240_000, ...over };
}

/** 造一份守卫配置（默认 fail-closed、无名单）。 */
function guard(over: Partial<SongGuardConfig> = {}): SongGuardConfig {
  return { ...DEFAULT_SONG_CONFIG.guard, ...over };
}

test('敏感词命中歌名：直接拒，且不给白名单机会', () => {
  const d = judgeSong({
    candidate: song({ title: '涉政歌曲' }),
    config: guard({ bannedWords: ['涉政'], whitelistSongIds: ['168091'] }),
  });
  assert.equal(d.verdict, 'block');
  assert.equal(d.reason, 'banned-word');
  assert.match(d.note, /涉政/);
});

test('敏感词也查观众输入的检索词（歌名干净、搜索词脏同样拦）', () => {
  const d = judgeSong({ candidate: song(), keyword: '赌博神曲', config: guard({ bannedWords: ['赌博'] }) });
  assert.equal(d.verdict, 'block');
  assert.equal(d.reason, 'banned-word');
});

test('曲目黑名单：精确 id 命中', () => {
  const d = judgeSong({ candidate: song(), config: guard({ blacklistSongIds: ['168091'] }) });
  assert.equal(d.verdict, 'block');
  assert.equal(d.reason, 'blacklist-song');
});

test('艺人黑名单：包含匹配能挡住「周杰伦 / 方文山」这种拼接', () => {
  const d = judgeSong({
    candidate: song({ artist: '周杰伦 / 方文山' }),
    config: guard({ blacklistArtists: ['周杰伦'] }),
  });
  assert.equal(d.verdict, 'block');
  assert.equal(d.reason, 'blacklist-artist');
});

test('黑名单优先于白名单：过期白名单盖不住硬红线', () => {
  const d = judgeSong({
    candidate: song(),
    config: guard({ whitelistSongIds: ['168091'], blacklistSongIds: ['168091'] }),
  });
  assert.equal(d.verdict, 'block');
});

test('白名单命中直接放行，不再看时长', () => {
  const d = judgeSong({
    candidate: song({ durationMs: 3_600_000 }),
    config: guard({ whitelistSongIds: ['168091'], rejectOverSec: 600 }),
  });
  assert.equal(d.verdict, 'allow');
  assert.equal(d.note, '命中白名单');
});

test('时长超过硬上限：拒', () => {
  const d = judgeSong({ candidate: song({ durationMs: 900_000 }), config: guard({ rejectOverSec: 600 }) });
  assert.equal(d.verdict, 'block');
  assert.equal(d.reason, 'too-long');
});

test('rejectOverSec = 0 表示不限时长', () => {
  const d = judgeSong({ candidate: song({ durationMs: 9_000_000 }), config: guard({ rejectOverSec: 0, mode: 'fail-open' }) });
  assert.notEqual(d.reason, 'too-long');
});

test('fail-closed：未知版权状态默认拒', () => {
  const d = judgeSong({ candidate: song(), config: guard({ mode: 'fail-closed' }) });
  assert.equal(d.verdict, 'block');
  assert.equal(d.reason, 'unverified');
});

test('fail-open：未知版权状态放行但标记待复核', () => {
  const d = judgeSong({ candidate: song(), config: guard({ mode: 'fail-open' }) });
  assert.equal(d.verdict, 'review');
  assert.equal(d.reason, 'unverified');
});

test('配置收敛：空串与空行被丢掉（否则 includes("") 会匹配一切）', () => {
  const normalized = normalizeGuardConfig(
    {
      mode: 'fail-open',
      whitelistSongIds: ['  ', '168091', '168091', ''],
      blacklistArtists: [' 周杰伦 ', ''],
      bannedWords: [],
      rejectOverSec: -5,
    },
    DEFAULT_SONG_CONFIG.guard,
  );
  assert.deepEqual(normalized.whitelistSongIds, ['168091']);
  assert.deepEqual(normalized.blacklistArtists, ['周杰伦']);
  assert.equal(normalized.rejectOverSec, DEFAULT_SONG_CONFIG.guard.rejectOverSec, '负数回落默认');
  assert.equal(normalized.mode, 'fail-open');
});

test('配置收敛：非法 mode 回落', () => {
  const normalized = normalizeGuardConfig({ mode: 'whatever' as never }, DEFAULT_SONG_CONFIG.guard);
  assert.equal(normalized.mode, 'fail-closed');
});
