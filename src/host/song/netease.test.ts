/**
 * 网易云适配器单测：深链构造、搜索响应投影、探测输出解析、注册表命令行解析。
 *
 * 只测纯函数——真正起客户端、发 HTTP 的部分留给联调，单测里跑那些会变成「测网络」。
 * @module live-pet/src/host/song/netease.test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlayUrl, parseExeFromCommand, parseProbeOutput, parseSearchResponse } from './netease.ts';

test('深链必须是 base64 命令载荷，而不是移动端的 /song/<id>', () => {
  const url = buildPlayUrl('168091');
  assert.ok(url.startsWith('orpheus://'));
  const payload = Buffer.from(url.slice('orpheus://'.length), 'base64').toString('utf8');
  assert.deepEqual(JSON.parse(payload), {
    type: 'song',
    id: '168091',
    cmd: 'play',
    channel: 'webset',
  });
});

test('songId 非纯数字一律拒绝（防注入）', () => {
  assert.throws(() => buildPlayUrl('168091&cmd=x'), /纯数字/);
  assert.throws(() => buildPlayUrl('../etc'), /纯数字/);
  assert.throws(() => buildPlayUrl(''), /纯数字/);
  assert.throws(() => buildPlayUrl('1'.repeat(21)), /纯数字/);
});

test('搜索响应投影：缺字段与非数字 id 丢掉，按 limit 截断', () => {
  const raw = {
    result: {
      songs: [
        { id: 168091, name: '蓝莲花', artists: [{ name: '许巍' }], duration: 240_000 },
        { id: '1330348068', name: '起风了', artists: [{ name: '冯沁苑' }, { name: '买辣椒也用券' }], duration: 325_000 },
        { id: 'abc', name: '脏 id' },
        { id: 1, name: '   ' },
        { id: 2, name: '第三首' },
      ],
    },
  };
  const list = parseSearchResponse(raw, 3);
  assert.equal(list.length, 3);
  assert.deepEqual(list[0], { id: '168091', title: '蓝莲花', artist: '许巍', durationMs: 240_000 });
  assert.equal(list[1]?.artist, '冯沁苑 / 买辣椒也用券');
});

test('搜索响应：结构不对时返回空数组，不抛', () => {
  assert.deepEqual(parseSearchResponse(null), []);
  assert.deepEqual(parseSearchResponse({}), []);
  assert.deepEqual(parseSearchResponse({ result: { songs: 'nope' } }), []);
});

test('搜索结果按 id 去重，duration 非法按 0', () => {
  const list = parseSearchResponse({
    result: {
      songs: [
        { id: 7, name: 'A', artists: [], duration: 'x' },
        { id: 7, name: 'A 重复', artists: [] },
      ],
    },
  });
  assert.equal(list.length, 1);
  assert.equal(list[0]?.durationMs, 0);
  assert.equal(list[0]?.artist, '');
});

test('探测输出解析：未运行 / 运行中带标题', () => {
  assert.deepEqual(parseProbeOutput('STATE:none\r\n'), { running: false, title: '' });
  assert.deepEqual(parseProbeOutput('STATE:ok\r\nTITLE:蓝莲花 - 许巍\r\n'), {
    running: true,
    title: '蓝莲花 - 许巍',
  });
  // 未运行时即使带了标题也不认（进程刚退出的竞态）
  assert.deepEqual(parseProbeOutput('STATE:none\nTITLE:残留标题'), { running: false, title: '' });
});

test('注册表命令行解析：引号后没有空格也要取到 exe', () => {
  assert.equal(
    parseExeFromCommand('"D:\\网易云\\CloudMusic\\cloudmusic.exe"--webcmd="%1"'),
    'D:\\网易云\\CloudMusic\\cloudmusic.exe',
  );
  assert.equal(parseExeFromCommand('"C:\\A B\\cloudmusic.exe" --webcmd="%1"'), 'C:\\A B\\cloudmusic.exe');
  assert.equal(parseExeFromCommand('not a command'), undefined);
});
