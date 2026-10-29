/**
 * 控制台脚本冒烟：只验证「能被解析」与关键页签是否注册。
 *
 * 控制台是单文件内联脚本，任何语法错误都会让整页静默变白，而接口全是 200——
 * 完整冒烟要 Electron（`npm run probe:console`），这里先用 `new Function` 把语法关守住。
 * @module live-pet/src/console/script.test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consoleScript } from './script.ts';
import { consoleStyle } from './style.ts';

test('控制台脚本可解析：语法错误会让整页白屏', () => {
  assert.doesNotThrow(() => new Function(consoleScript));
});

test('点歌页签已注册，且有对应渲染分支', () => {
  assert.match(consoleScript, /id: 'song'/);
  assert.match(consoleScript, /function renderSong\(/);
  assert.match(consoleScript, /state\.tab === 'song'/);
});

test('点歌页签调用的接口路径都带 /song 前缀', () => {
  const paths = [...consoleScript.matchAll(/API \+ '(\/song[^']*)'/g)].map((m) => m[1]);
  assert.ok(paths.length > 0, '至少要调用一个点歌接口');
  for (const path of paths) assert.match(path, /^\/song\//);
});

test('样式表包含点歌队列用到的类', () => {
  assert.match(consoleStyle, /\.songlist/);
  assert.match(consoleStyle, /\.songrow/);
  assert.match(consoleStyle, /\.btn\.sm/);
});
