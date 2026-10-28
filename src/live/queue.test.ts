/**
 * 互动队列单测：抽样比例、顺序保持、礼物必谢、队列上限、到点冲刷、历史记录。
 *
 * 随机源全部注入固定序列，断言才能稳定复现——这里测的是「规则」，不是「随机」。
 * @module live-pet/src/live/queue.test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InteractionQueue, estimateSpeechMs } from './queue.ts';
import type { LiveEvent } from './types.ts';

/** 造一条弹幕。 */
function chat(user: string, text: string): LiveEvent {
  return { kind: 'chat', user, text, ts: 0 };
}

/** 造一个礼物。 */
function gift(user: string, name = '小心心', count = 1): LiveEvent {
  return { kind: 'gift', user, giftName: name, giftCount: count, ts: 0 };
}

/** 固定序列的随机源：循环吐给定值，避免 Math.random 让断言飘。 */
function seq(values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[i % values.length];
    i += 1;
    return v;
  };
}

test('礼物必谢：比例为 0 也照样排队', () => {
  const q = new InteractionQueue({ maxPending: 50, sampleRatio: 0, flushMs: 1000 }, seq([0.9]));
  q.push(chat('小明', '666'), 0);
  q.push(gift('土豪', '火箭', 2), 1);
  q.flush(2000, true);

  // 弹幕被抽样刷掉，礼物留下
  const played = q.take(3000);
  assert.equal(played?.event.kind, 'gift');
  assert.equal(q.take(3001), undefined, '只剩礼物这一条');
});

test('抽样保持到达顺序：留下的按原顺序出队', () => {
  const q = new InteractionQueue({ maxPending: 10, sampleRatio: 0.5, flushMs: 1000 }, seq([0, 0, 0, 0]));
  for (let i = 1; i <= 10; i += 1) q.push(chat('u' + i, 'm' + i), i);
  q.flush(20, true);

  const order: string[] = [];
  for (let item = q.take(100); item !== undefined; item = q.take(100)) order.push(item.event.user);
  assert.equal(order.length, 5, '10 条留一半');
  // 顺序必须递增（先来的先播），不能因为抽样被打乱
  const indexes = order.map((u) => Number(u.slice(1)));
  assert.deepEqual(
    indexes,
    [...indexes].sort((a, b) => a - b),
  );
});

test('保底：只来一条、比例 0.5 时仍会留一条', () => {
  const q = new InteractionQueue({ maxPending: 50, sampleRatio: 0.5, flushMs: 1000 }, seq([0.99]));
  q.push(chat('小明', 'hi'), 0);
  q.flush(2000, true);
  assert.equal(q.pendingCount, 1, 'round(0.5)=1；即使算成 0 也要保底留 1 条');
});

test('攒够批量立刻决策，不必等到点', () => {
  const q = new InteractionQueue({ maxPending: 4, sampleRatio: 1, flushMs: 60_000 }, seq([0]));
  q.push(chat('a', '1'), 0);
  q.push(chat('b', '2'), 0);
  assert.equal(q.pendingCount, 0, '还没攒够，留在抽样批里');
  q.push(chat('c', '3'), 0);
  q.push(chat('d', '4'), 0);
  assert.equal(q.pendingCount, 4, '攒够 4 条后自动决策，全留');
});

test('未到点不决策，到点才冲刷', () => {
  const q = new InteractionQueue({ maxPending: 50, sampleRatio: 1, flushMs: 3000 }, seq([0]));
  q.push(chat('a', '1'), 0);
  assert.equal(q.flush(1000), 0, '距上次 1s，未到 3s');
  assert.equal(q.flush(3100), 1, '到点后放行');
});

test('队列满时挤掉最旧的，并记 queue-full', () => {
  const q = new InteractionQueue({ maxPending: 3, sampleRatio: 1, flushMs: 1000 }, seq([0]));
  for (let i = 1; i <= 5; i += 1) q.push(gift('u' + i), i);
  assert.equal(q.pendingCount, 3, '上限 3');
  const stats = q.stats();
  assert.equal(stats.droppedQueueFull, 2);
  // 留下的是最后 3 条
  const users: string[] = [];
  for (let item = q.take(10); item !== undefined; item = q.take(10)) users.push(item.event.user);
  assert.deepEqual(users, ['u3', 'u4', 'u5']);
});

test('手工注入不参与抽样，立刻可播', () => {
  const q = new InteractionQueue({ maxPending: 50, sampleRatio: 0, flushMs: 60_000 }, seq([0.5]));
  q.pushNow(chat('测试', '手动'), 0);
  assert.equal(q.pendingCount, 1, '比例为 0 也直接进待播队列');
});

test('历史最新在前，且受上限约束', () => {
  const q = new InteractionQueue({ maxPending: 50, sampleRatio: 1, flushMs: 1000, historyLimit: 20 }, seq([0]));
  for (let i = 1; i <= 30; i += 1) q.push(chat('u' + i, 'm'), i);
  const list = q.history(100);
  assert.equal(list.length, 20, 'historyLimit 生效');
  assert.equal(list[0]?.event.user, 'u30', '最新在前');
  assert.equal(list[19]?.event.user, 'u11', '最旧的被裁掉');
});

test('丢弃原因能区分抽样与队列满', () => {
  const q = new InteractionQueue({ maxPending: 2, sampleRatio: 0.5, flushMs: 1000 }, seq([0, 0]));
  for (let i = 1; i <= 6; i += 1) q.push(chat('u' + i, 'm'), i);
  q.flush(100, true);
  const dropped = q.history(50).filter((it) => it.status === 'dropped');
  assert.ok(
    dropped.some((it) => it.dropReason === 'sampled-out'),
    '有被抽样刷掉的',
  );
});

test('语音时长估算：随字数增长并夹在区间内', () => {
  assert.equal(estimateSpeechMs(''), 1200, '空串给下限');
  assert.equal(estimateSpeechMs('你好'), 1200, '很短的话取下限');
  const mid = estimateSpeechMs('这是一句大概二十个字左右的弹幕内容啊');
  assert.ok(mid > 1200 && mid < 15000, '中等长度落在区间内');
  assert.equal(estimateSpeechMs('啊'.repeat(500)), 15000, '超长取上限');
  assert.ok(estimateSpeechMs('这是一句二十个字左右的弹幕') > estimateSpeechMs('短句'));
});
