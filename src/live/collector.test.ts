/**
 * 采集器路径解析单测：三档优先级与「都没有就返回空串」。
 *
 * 这里只测纯函数 {@link resolveCollectorExecutable}：真起进程的部分依赖端口与可执行文件，
 * 放单测里既慢又脆，交给集成验证。
 * @module live-pet/src/live/collector.test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCollectorExecutable } from './collector.ts';

/** 造一个临时目录，跑完删掉。 */
function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'live-pet-collector-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 在指定位置放一个假的可执行文件（内容无所谓，只测路径解析）。 */
function touch(file: string): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, 'stub', 'utf8');
}

const BIN = process.platform === 'win32' ? 'douyinLive.exe' : 'douyinLive';

test('配置里填了路径就原样用，不做存在性判断（交给 ensure 报错）', () => {
  withTempDir((dir) => {
    const configured = join(dir, 'not-exist', BIN);
    assert.equal(resolveCollectorExecutable(configured, dir, {}), configured);
  });
});

test('配置为空时读环境变量 LIVE_PET_COLLECTOR_PATH', () => {
  withTempDir((dir) => {
    const fromEnv = join(dir, 'env', BIN);
    assert.equal(resolveCollectorExecutable('', dir, { LIVE_PET_COLLECTOR_PATH: fromEnv }), fromEnv);
  });
});

test('都没有配置时自动发现标准安装目录（<数据目录>/tools/douyinLive）', () => {
  withTempDir((dir) => {
    const bin = join(dir, 'tools', 'douyinLive', BIN);
    touch(bin);
    assert.equal(resolveCollectorExecutable('', dir, {}), bin);
  });
});

test('兼容上一层目录的安装位置（历史布局）', () => {
  withTempDir((dir) => {
    const configDir = join(dir, 'live-pet');
    mkdirSync(configDir, { recursive: true });
    const bin = join(dir, 'tools', 'douyinLive', BIN);
    touch(bin);
    assert.equal(resolveCollectorExecutable('', configDir, {}), bin);
  });
});

test('三档都拿不到时返回空串，由调用方报「未配置」', () => {
  withTempDir((dir) => {
    assert.equal(resolveCollectorExecutable('', dir, {}), '');
  });
});

test('显式配置优先于环境变量与标准目录', () => {
  withTempDir((dir) => {
    const explicit = join(dir, 'explicit', BIN);
    touch(explicit);
    touch(join(dir, 'tools', 'douyinLive', BIN));
    assert.equal(resolveCollectorExecutable(explicit, dir, { LIVE_PET_COLLECTOR_PATH: join(dir, 'env', BIN) }), explicit);
  });
});
