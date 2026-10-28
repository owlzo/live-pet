#!/usr/bin/env node
/**
 * 一键安装弹幕采集器（douyinLive）：下载 → 校验 SHA256 → 解压到标准目录。
 *
 * 为什么需要它：路线 A 的采集器是个独立进程，以前要么装 Go 自己编译、要么去 Releases 手动下载
 * 再解压到一个「记得住的位置」，最后还得把绝对路径粘进控制台——三步里错一步就是「连不上」。
 * 这里把前两步收成一条命令，落到 {@link targetDir}，宿主会自动发现（见 src/live/collector.ts）。
 *
 * 边界：
 * - 只装到固定目录，不改 PATH、不动系统；重复执行是幂等的（已存在就跳过，`--force` 才覆盖）；
 * - 必须校验 SHA256 才落盘：这是从公网拉可执行文件，校验失败直接中止；
 * - GitHub 直连慢时自动换镜像（可用 LIVE_PET_GH_MIRROR 指定自己的前缀）。
 *
 * 用法：npm run setup:collector [-- --force] [-- --tag v2.3.2]
 * @module live-pet/scripts/setup-collector
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

/** 仓库标识（下载地址由它拼出来）。 */
const REPO = 'jwwsjlm/douyinLive';
/** GitHub 直连地址前缀；直连失败时按顺序换这些镜像。 */
const MIRRORS = ['', 'https://ghfast.top/', 'https://gh-proxy.com/'];
/** 默认版本；不写就用 GitHub 上最新的正式版。 */
const DEFAULT_TAG = 'latest';

/**
 * 数据目录：与 ensure-electron / start-app 同一套解析顺序。
 * 采集器装到 `<home>/tools/douyinLive/`，宿主的 resolveCollectorExecutable 会去这里找。
 */
const HOME =
  process.env.LIVE_PET_HOME ||
  process.env.DSH_HOME ||
  join(process.env.USERPROFILE || process.env.HOME || homedir(), '.live-pet');

/** 平台对应的发布包后缀与可执行文件名。 */
const PLATFORM = (() => {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  if (process.platform === 'win32') return { asset: `windows-${arch}.zip`, bin: 'douyinLive.exe', zip: true };
  if (process.platform === 'darwin') return { asset: `darwin-${arch}.tar.gz`, bin: 'douyinLive', zip: false };
  return { asset: `linux-${arch}.tar.gz`, bin: 'douyinLive', zip: false };
})();

/** 安装目录。 */
const targetDir = join(HOME, 'tools', 'douyinLive');
/** 安装后的可执行文件绝对路径。 */
const targetBin = join(targetDir, PLATFORM.bin);

/**
 * 单次 HTTP GET。
 *
 * Node 自带的 fetch（undici）**不读** `HTTPS_PROXY` 这类环境变量，而国内机器十有八九配了代理；
 * curl 恰好读它们，所以配了代理时优先用 curl，没配或 curl 不可用再回落到 fetch。
 *
 * @param url - 完整地址。
 * @param timeoutMs - 超时（毫秒）。
 * @returns 响应体字节。
 */
async function httpGet(url, timeoutMs = 300_000) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (proxy && process.env.LIVE_PET_NO_CURL !== '1') {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('curl', ['-fsSL', '--max-time', String(Math.round(timeoutMs / 1000)), url], {
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status === 0 && r.stdout) return r.stdout;
    // curl 失败不直接放弃：目标机器可能没有 curl，交给下面的 fetch 再试一次
  }
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 带镜像回退的下载。
 *
 * @param path - 仓库内相对路径（`/releases/download/...`）。
 * @returns 响应体字节。
 */
async function download(path) {
  const errors = [];
  for (const mirror of MIRRORS) {
    const url = `${mirror}https://github.com${path}`;
    try {
      return await httpGet(url);
    } catch (error) {
      errors.push(`${mirror || '直连'} → ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error('下载失败：\n  ' + errors.join('\n  '));
}

/**
 * 查最新正式版 tag。
 *
 * GitHub API 有匿名限流，所以失败时回退到「直接请求 latest 的跳转地址」拿 tag。
 *
 * @returns 形如 `v2.3.2` 的 tag。
 */
async function latestTag() {
  try {
    const body = JSON.parse(await httpGet(`https://api.github.com/repos/${REPO}/releases/latest`, 20_000).then((b) => b.toString('utf8')));
    if (typeof body.tag_name === 'string' && body.tag_name !== '') return body.tag_name;
  } catch {
    // 落到下面的跳转探测
  }
  // 回退：/releases/latest 会 302 到 /releases/tag/<tag>
  const res = await fetch(`https://github.com/${REPO}/releases/latest`, { redirect: 'manual' });
  const location = res.headers.get('location') ?? '';
  const tag = location.split('/tag/')[1];
  if (tag === undefined || tag === '') throw new Error('无法确定最新版本，请用 --tag 指定');
  return tag;
}

/**
 * 极简 zip 解包（只支持 store / deflate，够解发布包）。
 *
 * 不引第三方依赖：这个脚本要在 `npm install` 之后、甚至打包环境里跑，多一个依赖就多一处风险。
 *
 * @param buffer - zip 字节。
 * @param outDir - 解压目标目录。
 * @returns 写出的文件数。
 */
function unzip(buffer, outDir) {
  // 从尾部找 EOCD（0x06054b50），注释最长 65535 字节
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip 结构损坏：找不到 EOCD');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  let written = 0;
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('zip 结构损坏：中央目录项无效');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);
    offset += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) {
      mkdirSync(join(outDir, name), { recursive: true });
      continue;
    }
    // 防路径穿越：发布包里不应出现 ..，出现就当作损坏
    if (name.includes('..') || name.startsWith('/')) throw new Error(`压缩包内路径非法：${name}`);

    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? raw : inflateRawSync(raw);
    const out = join(outDir, name);
    mkdirSync(join(out, '..'), { recursive: true });
    writeFileSync(out, data);
    written += 1;
  }
  return written;
}

/** 主流程。 */
async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const tagArg = args.indexOf('--tag');
  const tag = tagArg >= 0 ? args[tagArg + 1] : DEFAULT_TAG;

  if (existsSync(targetBin) && !force) {
    console.log(`[collector] 已安装：${targetBin}`);
    console.log('[collector] 需要重装请加 --force');
    return;
  }

  const resolvedTag = tag === 'latest' ? await latestTag() : tag;
  console.log(`[collector] 目标版本：${resolvedTag}（${PLATFORM.asset}）`);

  // 发布包名形如 douyinLive-v2.3.2-<sha>-windows-amd64.zip，中间的 sha 只能从列表里查
  const assets = await download(`/${REPO}/releases/expanded_assets/${resolvedTag}`).then((b) => b.toString('utf8'));
  const matched = [...assets.matchAll(new RegExp(`/${REPO}/releases/download/[^"']*?${PLATFORM.asset.replace('.', '\\.')}`, 'g'))];
  const assetPath = matched[0]?.[0];
  if (assetPath === undefined) throw new Error(`发布包里找不到 ${PLATFORM.asset}`);

  const archive = await download(assetPath);
  console.log(`[collector] 已下载 ${(archive.length / 1048576).toFixed(1)} MB，校验中…`);

  // 校验：checksums.txt 与包同目录，行格式 `<sha256>  <文件名>`
  const assetName = assetPath.split('/').pop();
  const checksumPath = assetPath.replace(assetName, assetName.replace(PLATFORM.asset, 'checksums.txt'));
  const sums = await download(checksumPath).then((b) => b.toString('utf8'));
  const expected = sums
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find((cols) => cols[1] === assetName)?.[0];
  const actual = createHash('sha256').update(archive).digest('hex');
  if (expected === undefined) throw new Error('校验文件里没有这个包，拒绝安装');
  if (expected !== actual) throw new Error(`SHA256 不匹配：期望 ${expected}，实际 ${actual}`);

  mkdirSync(targetDir, { recursive: true });
  if (PLATFORM.zip) {
    const files = unzip(archive, targetDir);
    console.log(`[collector] 已解压 ${files} 个文件`);
  } else {
    // tar.gz 用系统 tar（macOS / Linux 一定有）
    const { spawnSync } = await import('node:child_process');
    const tmp = join(targetDir, 'download.tar.gz');
    writeFileSync(tmp, archive);
    const r = spawnSync('tar', ['-xzf', tmp, '-C', targetDir], { stdio: 'inherit' });
    rmSync(tmp, { force: true });
    if (r.status !== 0) throw new Error('tar 解压失败');
  }

  if (!existsSync(targetBin)) throw new Error(`解压后没有找到 ${PLATFORM.bin}`);
  if (!PLATFORM.zip) chmodSync(targetBin, 0o755);
  // 校验通过才留档，便于排查「装的到底是哪一版」
  writeFileSync(join(targetDir, 'VERSION'), `${resolvedTag}\n${actual}\n`, 'utf8');

  console.log(`[collector] 安装完成：${targetBin}`);
  console.log('[collector] 宿主会自动发现它，启动桌宠即可；控制台「弹幕采集器」卡片可查看状态');
}

main().catch((error) => {
  console.error(`[collector] 安装失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
