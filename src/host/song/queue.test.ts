/**
 * 点歌队列单测：FIFO、去重窗口、用户冷却与配额、队满、删除与历史。
 *
 * 时间全部由参数注入，不依赖真实时钟——这条队列的规则全是时间窗口，靠 sleep 测必然飘。
 * @module live-pet/src/host/song/queue.test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SongQueue, normalizeQueueConfig } from './queue.ts';
import type { SongCandidate, SongQueueConfig } from './types.ts';

/** 默认测试参数：窗口都拉满，单条用例只改自己关心的那一项。 */
function options(over: Partial<SongQueueConfig> = {}): SongQueueConfig {
  return { maxPending: 10, perUserCooldownSec: 0, perUserMaxPerHour: 100, duplicateWindowSec: 0, ...over };
}

/** 造一首候选。 */
function song(id = '168091', title = '蓝莲花'): SongCandidate {
  return { id, title, artist: '许巍', durationMs: 240_000 };
}

/** 入队一条（默认全部通过）。 */
function push(q: SongQueue, user: string, now: number, s: SongCandidate = song()) {
  return q.push({ user, raw: `点歌 ${s.title}`, song: s, verdict: 'allow', now });
}

test('FIFO：按入队顺序出队，出队即 requesting', () => {
  const q = new SongQueue(options());
  push(q, 'A', 1, song('1', '第一首'));
  push(q, 'B', 2, song('2', '第二首'));
  push(q, 'C', 3, song('3', '第三首'));

  const first = q.take(10);
  assert.equal(first?.song?.title, '第一首');
  assert.equal(first?.status, 'requesting');
  assert.equal(q.size, 2);
});

test('空队列取不到东西', () => {
  assert.equal(new SongQueue(options()).take(1), undefined);
});

test('去重：窗口内同一首歌再点直接拒', () => {
  const q = new SongQueue(options({ duplicateWindowSec: 1800 }));
  assert.equal(push(q, 'A', 1000).ok, true);
  const again = push(q, 'B', 2000);
  assert.equal(again.ok, false);
  assert.equal(again.ok === false ? again.reason : '', 'duplicate');
});

test('去重窗口过期后可以再点', () => {
  const q = new SongQueue(options({ duplicateWindowSec: 60 }));
  push(q, 'A', 1000);
  const later = push(q, 'B', 1000 + 61_000);
  assert.equal(later.ok, true);
});

test('播放失败过的曲目不算「已点过」，允许重试', () => {
  const q = new SongQueue(options({ duplicateWindowSec: 1800 }));
  const first = push(q, 'A', 1000);
  assert.equal(first.ok, true);
  if (first.ok) q.finish(first.item, 'failed', 1500, 'play-failed');
  assert.equal(push(q, 'B', 2000).ok, true);
});

test('用户冷却：窗口内同一用户再点被拒，别人不受影响', () => {
  const q = new SongQueue(options({ perUserCooldownSec: 300 }));
  push(q, 'A', 1000);
  const same = push(q, 'A', 2000, song('2', '另一首'));
  assert.equal(same.ok, false);
  assert.equal(same.ok === false ? same.reason : '', 'cooldown');
  assert.equal(push(q, 'B', 2000, song('3', '第三首')).ok, true, '别人的冷却互不影响');
});

test('配额：每人每小时最多 N 首', () => {
  const q = new SongQueue(options({ perUserMaxPerHour: 2 }));
  assert.equal(push(q, 'A', 1000, song('1', '一')).ok, true);
  assert.equal(push(q, 'A', 2000, song('2', '二')).ok, true);
  const third = push(q, 'A', 3000, song('3', '三'));
  assert.equal(third.ok, false);
  assert.equal(third.ok === false ? third.reason : '', 'quota');
  // 一小时后再点可以
  assert.equal(push(q, 'A', 3600_000 + 1000, song('4', '四')).ok, true);
});

test('队满：超上限拒绝，且不影响已在队列里的条目', () => {
  const q = new SongQueue(options({ maxPending: 2 }));
  assert.equal(push(q, 'A', 1, song('1', '一')).ok, true);
  assert.equal(push(q, 'B', 2, song('2', '二')).ok, true);
  const full = push(q, 'C', 3, song('3', '三'));
  assert.equal(full.ok, false);
  assert.equal(full.ok === false ? full.reason : '', 'queue-full');
  assert.equal(q.size, 2);
});

test('删一条：只删待播，正在播的那条已经不在队列里', () => {
  const q = new SongQueue(options());
  const a = push(q, 'A', 1, song('1', '一'));
  push(q, 'B', 2, song('2', '二'));
  assert.equal(a.ok, true);
  const id = a.ok ? a.item.id : 0;
  assert.equal(q.remove(id, 100), true);
  assert.equal(q.size, 1);
  assert.equal(q.remove(999, 200), false, '不存在的 id 返回 false');
});

test('清空：返回清掉的条数', () => {
  const q = new SongQueue(options());
  push(q, 'A', 1, song('1', '一'));
  push(q, 'B', 2, song('2', '二'));
  assert.equal(q.clear(), 2);
  assert.equal(q.size, 0);
});

test('历史：最新在前，且包含已播完的条目', () => {
  const q = new SongQueue(options());
  const a = push(q, 'A', 1, song('1', '一'));
  const b = push(q, 'B', 2, song('2', '二'));
  if (a.ok) q.finish(a.item, 'ended', 10);
  const list = q.listHistory(10);
  assert.equal(list.length, 2);
  assert.equal(list[0]?.id, b.ok ? b.item.id : 0, '最新在前');
  assert.equal(list[1]?.status, 'ended');
});

test('计数：accepted 只统计入队成功的，dropped 统计被拒的', () => {
  const q = new SongQueue(options({ maxPending: 1 }));
  push(q, 'A', 1, song('1', '一'));
  push(q, 'B', 2, song('2', '二'));
  const stats = q.stats();
  assert.equal(stats.accepted, 1);
  assert.equal(stats.dropped, 1);
  assert.equal(stats.pending, 1);
});

test('参数收敛：越界值夹到合法区间', () => {
  const normalized = normalizeQueueConfig(
    { maxPending: 0, perUserCooldownSec: -1, perUserMaxPerHour: 999, duplicateWindowSec: 10 },
    options(),
  );
  assert.equal(normalized.maxPending, 1);
  assert.equal(normalized.perUserCooldownSec, 0);
  assert.equal(normalized.perUserMaxPerHour, 60);
  assert.equal(normalized.duplicateWindowSec, 10);
});
