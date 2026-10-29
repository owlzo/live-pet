/**
 * 点歌指令解析单测：三种写法、全角与标点、误伤边界。
 *
 * 重点在「不该认的别认」——把一句普通聊天误判成点歌，观众会觉得宠物在乱接话。
 * @module live-pet/src/live/song/command.test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SONG_KEYWORD_LENGTH, normalizeSongKey, parseSongCommand } from './command.ts';

test('三种写法都认：空格、冒号、直接连写', () => {
  assert.equal(parseSongCommand('点歌 蓝莲花')?.keyword, '蓝莲花');
  assert.equal(parseSongCommand('点歌：蓝莲花')?.keyword, '蓝莲花');
  assert.equal(parseSongCommand('点歌蓝莲花')?.keyword, '蓝莲花');
});

test('多前缀与全角字符：长前缀优先，全角空格照样吃', () => {
  assert.equal(parseSongCommand('来一首 起风了')?.prefix, '来一首');
  assert.equal(parseSongCommand('想听　蓝莲花')?.keyword, '蓝莲花', '全角空格要当分隔符');
  assert.equal(parseSongCommand('点播　：　蓝莲花')?.keyword, '蓝莲花');
});

test('尾部标点与空白被剥掉', () => {
  assert.equal(parseSongCommand('点歌 蓝莲花！！')?.keyword, '蓝莲花');
  assert.equal(parseSongCommand('点歌 蓝莲花   ')?.keyword, '蓝莲花');
  assert.equal(parseSongCommand('点歌《蓝莲花》')?.keyword, '蓝莲花', '书名号是包裹符号，不是歌名的一部分');
  assert.equal(parseSongCommand('点歌「蓝莲花」')?.keyword, '蓝莲花');
});

test('不是命令的一律不认', () => {
  assert.equal(parseSongCommand('主播好呀'), null);
  assert.equal(parseSongCommand('我点歌单里的歌都听腻了'), null, '句中带「点歌」不算');
  assert.equal(parseSongCommand('点歌'), null, '只有前缀没有检索词');
  assert.equal(parseSongCommand('点歌 ？？？'), null, '纯标点没有检索价值');
  assert.equal(parseSongCommand(''), null);
  assert.equal(parseSongCommand('   '), null);
});

test('超长检索词不认（挡住粘贴长文本刷屏）', () => {
  const long = '歌'.repeat(MAX_SONG_KEYWORD_LENGTH + 1);
  assert.equal(parseSongCommand(`点歌 ${long}`), null);
  assert.notEqual(parseSongCommand(`点歌 ${'歌'.repeat(MAX_SONG_KEYWORD_LENGTH)}`), null);
});

test('零宽字符与全角字母归一化', () => {
  assert.equal(parseSongCommand('点歌\u200B蓝莲花')?.keyword, '蓝莲花');
  assert.equal(parseSongCommand('点歌 ＬＥＴＩＴＢＥ')?.keyword, 'LETITBE');
});

test('歌名归一化：去括号内容、空白与标点，统一小写', () => {
  assert.equal(normalizeSongKey('蓝莲花 (Live)'), '蓝莲花');
  assert.equal(normalizeSongKey('起风了【伴奏】'), '起风了');
  assert.equal(normalizeSongKey('  A-B  '), 'ab');
  // 不剥括号外的后缀：这里只负责「同一首歌的稳定比较键」，多余词靠包含匹配兼容
  assert.equal(normalizeSongKey('Let It Be - Remastered'), 'letitberemastered');
});
