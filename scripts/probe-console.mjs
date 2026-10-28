#!/usr/bin/env node
/**
 * 启动控制台冒烟探针：找到本机 Electron 后把 scripts/console-probe.cjs 交给它跑。
 *
 * 不把 electron 放进依赖：本项目一直用「外部 Electron 二进制」，这里沿用同一套查找顺序
 * （LIVE_PET_ELECTRON_PATH → DSH_PET_ELECTRON_PATH → $LIVE_PET_HOME/electron）。
 * @module live-pet/scripts/probe-console
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = process.env.LIVE_PET_HOME || process.env.DSH_HOME || join(homedir(), '.live-pet');
const rel =
  process.platform === 'win32'
    ? 'electron.exe'
    : process.platform === 'darwin'
      ? join('Electron.app', 'Contents', 'MacOS', 'Electron')
      : 'electron';

const electron = [
  process.env.LIVE_PET_ELECTRON_PATH,
  process.env.DSH_PET_ELECTRON_PATH,
  join(home, 'electron', rel),
].find((value) => value && existsSync(value));

if (!electron) {
  console.error('[probe] 找不到 Electron：设置 LIVE_PET_ELECTRON_PATH，或先跑 npm run ensure:electron');
  process.exit(1);
}

// ELECTRON_RUN_AS_NODE 会让 Electron 以纯 Node 运行，require('electron') 直接失败。
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [join(root, 'scripts', 'console-probe.cjs')], {
  cwd: root,
  env,
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
