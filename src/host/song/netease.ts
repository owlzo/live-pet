/**
 * 网易云客户端适配器：搜索走 HTTP、播放走 `orpheus://` 协议、状态靠窗口标题探测。
 *
 * 三段各自的约束：
 * 1. **搜索**不经过客户端——协议是单向投递，没有返回值；官方页面分享用的 `orpheus://` 载荷里也没有检索结果。
 * 2. **播放**必须是 base64 命令载荷（`{"type":"song","id":…,"cmd":"play"}`），移动端那种 `orpheus://song/{id}`
 *    在桌面上只会唤起窗口、不会切歌（本机 v3.1.34 实测）。
 * 3. **观测**只能从外部看：窗口标题（`歌名 - 歌手`）。协议没有「播完了」的回执，这是本方案最大的信息缺口。
 *
 * 必须始终成立：`songId` 必须纯数字才能拼进载荷；URL 只由本模块构造，绝不接受外部传入的整串 URL。
 * @module live-pet/src/host/song/netease
 */

import { spawn } from 'node:child_process';
import type { SongCandidate, SongClientHealth } from './types.ts';

/** 搜索接口（未公开的 Web 接口，见方案 §3.2）。 */
const SEARCH_ENDPOINT = 'https://music.163.com/api/search/get';

/** 协议名：客户端安装时写入 HKCR，命令行为 `cloudmusic.exe --webcmd="%1"`。 */
const PROTOCOL = 'orpheus';

/** songId 白名单：只允许纯数字，堵住拼进 base64 的任何杂质。 */
const SONG_ID = /^\d{1,20}$/;

/** 搜索超时：点歌是实时交互，宁可失败也不能把互动泵卡住。 */
const SEARCH_TIMEOUT_MS = 2500;

/** 子进程探测超时。 */
const PROBE_TIMEOUT_MS = 4000;

/** 一次探测的结果。 */
export interface PlayerProbe {
  running: boolean;
  title: string;
}

/**
 * 构造播放深链。
 *
 * @param songId - 平台歌曲 id（纯数字）。
 * @returns `orpheus://<base64(JSON)>`。
 * @throws {Error} id 不是纯数字时抛出——这是防注入的最后一道闸。
 */
export function buildPlayUrl(songId: string): string {
  if (!SONG_ID.test(songId)) throw new Error(`songId 必须是纯数字：${songId.slice(0, 32)}`);
  const payload = JSON.stringify({ type: 'song', id: songId, cmd: 'play', channel: 'webset' });
  return `${PROTOCOL}://${Buffer.from(payload, 'utf8').toString('base64')}`;
}

/** 从搜索响应里提候选：字段缺失或 id 非数字的条目直接丢。 */
export function parseSearchResponse(raw: unknown, limit = 3): SongCandidate[] {
  const songs = (raw as { result?: { songs?: unknown } } | null)?.result?.songs;
  if (!Array.isArray(songs)) return [];
  const out: SongCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of songs) {
    if (entry === null || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    const id = typeof o.id === 'number' ? String(o.id) : typeof o.id === 'string' ? o.id : '';
    if (!SONG_ID.test(id) || seen.has(id)) continue;
    const title = typeof o.name === 'string' ? o.name.trim() : '';
    if (title === '') continue;
    const artists = Array.isArray(o.artists)
      ? o.artists
          .map((a) => (a !== null && typeof a === 'object' ? String((a as Record<string, unknown>).name ?? '') : ''))
          .filter((name) => name !== '')
      : [];
    const duration = Number(o.duration);
    seen.add(id);
    out.push({
      id,
      title,
      artist: artists.join(' / '),
      durationMs: Number.isFinite(duration) && duration > 0 ? duration : 0,
    });
    if (out.length >= Math.max(1, limit)) break;
  }
  return out;
}

/** 解析 PowerShell 探测输出（`STATE:ok` + `TITLE:…`）。 */
export function parseProbeOutput(text: string): PlayerProbe {
  const lines = text.split(/\r?\n/);
  let running = false;
  let title = '';
  for (const line of lines) {
    if (line.startsWith('STATE:')) running = line.slice('STATE:'.length).trim() === 'ok';
    else if (line.startsWith('TITLE:')) title = line.slice('TITLE:'.length).trim();
  }
  return { running, title: running ? title : '' };
}

/** 从注册表命令行里取 exe 路径：`"D:\…\cloudmusic.exe"--webcmd="%1"`（引号后无空格）。 */
export function parseExeFromCommand(command: string): string | undefined {
  const match = /^"([^"]+\.exe)"/i.exec(command.trim());
  return match?.[1] === undefined ? undefined : match[1];
}

/** 适配器对外能力。 */
export interface NeteaseAdapter {
  /** 搜索候选曲目；网络或解析失败返回空数组（不抛，调用方按「没找到」处理）。 */
  search(keyword: string, limit?: number): Promise<SongCandidate[]>;
  /** 投递播放命令；失败抛错（调用方据此标记 play-failed）。 */
  play(songId: string): Promise<void>;
  /** 探测客户端是否在跑、当前在放什么。 */
  probe(): Promise<SongClientHealth>;
  /** 解析客户端可执行文件路径（注册表）；解析不到返回 undefined。 */
  resolveExePath(): Promise<string | undefined>;
  /** 以最小化方式拉起客户端（不投递命令）。 */
  launch(): Promise<boolean>;
}

/** 依赖注入面：子进程与 fetch 都可替换，便于单测与排障。 */
export interface NeteaseDeps {
  log: { info(message: string): void; warn(message: string): void };
  /** 打开一个 URL（缺省走 rundll32，失败回落 cmd start）。 */
  openUrl?: (url: string) => Promise<void>;
  /** 跑一段 PowerShell 并取 stdout（缺省起 powershell.exe）。 */
  runPowerShell?: (script: string, timeoutMs?: number) => Promise<string>;
  /** 起一个脱离的子进程（缺省用 node:child_process.spawn）。 */
  spawnDetached?: (file: string, args: readonly string[]) => Promise<void>;
  /** fetch 实现（单测注入）。 */
  fetchImpl?: typeof fetch;
  /** 平台判定（单测注入）。 */
  platform?: NodeJS.Platform;
  /** 客户端 exe 路径（配置里填了就不用读注册表）。 */
  exePath?: () => string;
}

/** 跑一段命令并收集 stdout；超时或非零退出都抛。 */
function runOnce(file: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`${file} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${file} 退出码 ${String(code)}`));
    });
  });
}

/** 探测脚本：整段一行，输出 UTF-8，避免中文歌名在 GBK 控制台里变乱码。 */
const PROBE_SCRIPT = [
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8;',
  "$p=Get-Process -Name cloudmusic -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1;",
  "if($null -eq $p){ 'STATE:none' } else { 'STATE:ok'; 'TITLE:' + $p.MainWindowTitle }",
].join(' ');

/** 取 exe 路径的脚本（注册表读协议命令行）。 */
const EXE_SCRIPT = [
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8;',
  "$c=(Get-ItemProperty -Path 'Registry::HKEY_CLASSES_ROOT\\orpheus\\shell\\open\\command' -ErrorAction SilentlyContinue).'(default)';",
  "if($c){ $c } else { 'NONE' }",
].join(' ');

/** 创建适配器。 */
export function createNeteaseAdapter(deps: NeteaseDeps): NeteaseAdapter {
  const { log } = deps;
  const platform = deps.platform ?? process.platform;
  const doFetch = deps.fetchImpl ?? fetch;
  const runPs =
    deps.runPowerShell ??
    ((script: string, timeoutMs = PROBE_TIMEOUT_MS) =>
      runOnce('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], timeoutMs));
  const spawnDetached =
    deps.spawnDetached ??
    (async (file: string, args: readonly string[]): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(file, args, { windowsHide: true, stdio: 'ignore', detached: true });
        child.once('error', reject);
        child.once('spawn', () => {
          child.unref();
          resolve();
        });
      });
    });

  const openUrl =
    deps.openUrl ??
    (async (url: string): Promise<void> => {
      // rundll32 走 ShellExecute，参数是分开传的，不需要经过 cmd 的引号解析
      try {
        await spawnDetached('rundll32.exe', ['url.dll,FileProtocolHandler', url]);
        return;
      } catch (error) {
        log.warn(`[live-pet] rundll32 打开协议失败，回落 cmd start：${error instanceof Error ? error.message : String(error)}`);
      }
      await spawnDetached('cmd.exe', ['/d', '/s', '/c', 'start', '""', url]);
    });

  let lastProbe: SongClientHealth = { running: false, title: '' };

  return {
    async search(keyword: string, limit = 3): Promise<SongCandidate[]> {
      const trimmed = keyword.trim();
      if (trimmed === '') return [];
      const url = `${SEARCH_ENDPOINT}?s=${encodeURIComponent(trimmed)}&type=1&limit=${Math.max(1, Math.min(10, limit))}`;
      try {
        const res = await doFetch(url, {
          headers: {
            // 这个接口对空 Referer 会拒绝，带上站点自己用的那一个
            referer: 'https://music.163.com/',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) live-pet',
          },
          signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
        });
        if (!res.ok) {
          log.warn(`[live-pet] 点歌搜索失败：HTTP ${res.status}`);
          return [];
        }
        const json: unknown = await res.json();
        return parseSearchResponse(json, limit);
      } catch (error) {
        log.warn(`[live-pet] 点歌搜索异常：${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    },

    async play(songId: string): Promise<void> {
      if (platform !== 'win32') throw new Error('点歌播放只支持 Windows 客户端');
      await openUrl(buildPlayUrl(songId));
    },

    async probe(): Promise<SongClientHealth> {
      try {
        const out = await runPs(PROBE_SCRIPT);
        const parsed = parseProbeOutput(out);
        lastProbe = { running: parsed.running, title: parsed.title, checkedAt: Date.now() };
      } catch (error) {
        lastProbe = {
          running: false,
          title: '',
          lastError: error instanceof Error ? error.message : String(error),
          checkedAt: Date.now(),
        };
      }
      return lastProbe;
    },

    async resolveExePath(): Promise<string | undefined> {
      const configured = deps.exePath?.().trim() ?? '';
      if (configured !== '') return configured;
      if (platform !== 'win32') return undefined;
      try {
        const out = await runPs(EXE_SCRIPT);
        const line = out.split(/\r?\n/).find((l) => l.trim() !== '' && l.trim() !== 'NONE');
        return line === undefined ? undefined : parseExeFromCommand(line);
      } catch (error) {
        log.warn(`[live-pet] 读取 orpheus 协议注册信息失败：${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    },

    async launch(): Promise<boolean> {
      if (platform !== 'win32') return false;
      const exe = await this.resolveExePath();
      if (exe === undefined) {
        log.warn('[live-pet] 未找到网易云客户端路径，无法自动拉起');
        return false;
      }
      try {
        // 用 Start-Process 而不是直接 spawn：只有它能把「最小化」交给 Windows 的 STARTUPINFO，
        // 直接 spawn 出来的窗口一定是常规尺寸。只拉起、不带 --webcmd，预热阶段不发任何播放指令。
        const quoted = exe.replace(/'/g, "''");
        await runPs(`Start-Process -FilePath '${quoted}' -WindowStyle Minimized`, PROBE_TIMEOUT_MS);
        log.info(`[live-pet] 已尝试拉起网易云客户端：${exe}`);
        return true;
      } catch (error) {
        log.warn(`[live-pet] 拉起网易云客户端失败：${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    },
  };
}
