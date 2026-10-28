/**
 * 去重器单测：窗口内放行上限、窗口过期重置、键不串味、抑制计数。
 * @module live-pet/src/live/dedupe.test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Deduper, dedupeKey } from './dedupe.ts';
import type { LiveEvent } from './types.ts';

/** 造一条弹幕。 */
function chat(user: string, text: string, ts = 0): LiveEvent {
  return { kind: 'chat', user, text, ts };
}

test('窗口内只放行前 N 次，其余被抑制', () => {
  const d = new Deduper({ windowMs: 30_000, maxPerWindow: 3 });
  assert.equal(d.admit(chat('小明', '666'), 0), true);
  assert.equal(d.admit(chat('小明', '666'), 1), true);
  assert.equal(d.admit(chat('小明', '666'), 2), true);
  assert.equal(d.admit(chat('小明', '666'), 3), false);
  assert.equal(d.admit(chat('小明', '666'), 4), false);
  assert.equal(d.suppressedCount(), 2);
});

test('窗口过期后重新计数', () => {
  const d = new Deduper({ windowMs: 1000, maxPerWindow: 1 });
  assert.equal(d.admit(chat('a', 'hi'), 0), true);
  assert.equal(d.admit(chat('a', 'hi'), 500), false);
  assert.equal(d.admit(chat('a', 'hi'), 1001), true);
});

test('不同用户或不同内容互不影响', () => {
  const d = new Deduper({ windowMs: 30_000, maxPerWindow: 1 });
  assert.equal(d.admit(chat('a', 'hi'), 0), true);
  assert.equal(d.admit(chat('b', 'hi'), 0), true);
  assert.equal(d.admit(chat('a', 'hello'), 0), true);
  assert.equal(d.suppressedCount(), 0);
});

test('礼物按「用户 + 礼物名」去重，数量不影响键', () => {
  const d = new Deduper({ windowMs: 30_000, maxPerWindow: 1 });
  const one: LiveEvent = { kind: 'gift', user: 'a', giftName: '小心心', giftCount: 1, ts: 0 };
  const many: LiveEvent = { kind: 'gift', user: 'a', giftName: '小心心', giftCount: 99, ts: 1 };
  assert.equal(d.admit(one, 0), true);
  assert.equal(d.admit(many, 1), false);
});

test('键用分隔符拼接，不会因字符串相邻而撞键', () => {
  assert.notEqual(dedupeKey(chat('ab', 'c')), dedupeKey(chat('a', 'bc')));
});

test('prune 清掉过期键，size 只数未过期的', () => {
  const d = new Deduper({ windowMs: 1000, maxPerWindow: 1 });
  d.admit(chat('a', 'x'), 0);
  d.admit(chat('b', 'y'), 0);
  assert.equal(d.size(500), 2);
  d.prune(2000);
  assert.equal(d.size(2000), 0);
});

test('reset 同时清空计数与抑制数', () => {
  const d = new Deduper({ windowMs: 30_000, maxPerWindow: 1 });
  d.admit(chat('a', 'x'), 0);
  d.admit(chat('a', 'x'), 1);
  assert.equal(d.suppressedCount(), 1);
  d.reset();
  assert.equal(d.suppressedCount(), 0);
  assert.equal(d.size(1), 0);
});
