/**
 * 宠物语音（TTS）：把「要说的那句话」合成成一段 mp3，交给桌面端播放。
 *
 * 引擎用 msedge-tts（MIT，Edge「大声朗读」接口的 Node 移植）：不装任何外部运行时、
 * 不需要 API Key、中文音色自然，代价是必须联网。合成结果按「音色 + 语速 + 文本」哈希缓存到
 * 用户目录，同一句话重复出现不再走网络。
 *
 * 只负责「文本 → 文件 → 通知调用方」；谁触发、播不播、音量多大都归调用方（宿主装配与桌面端）。
 * 必须始终成立：任何失败只记日志并降级为「没有语音」，绝不影响气泡与动画。
 * @module live-pet/src/host/voice
 */
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

/** 语音配置（持久化在 `<userRoot>/voice-config.json`）。 */
export interface VoiceConfig {
  /** 总开关：关掉后一句话都不合成，也不发请求。 */
  enabled: boolean;
  /** 音色 ShortName（见 VOICES）。 */
  voice: string;
  /** 语速相对百分比，-50 ~ +100。 */
  rate: number;
  /** 播放音量 0 ~ 1（桌面端读它设 Audio.volume）。 */
  volume: number;
  /** 单句最长字符数，超出截断：长文本合成慢且容易盖住后面的弹幕。 */
  maxChars: number;
}

/** 默认配置：开箱就有声音，音色取最常见的女声。 */
export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  enabled: true,
  voice: 'zh-CN-XiaoxiaoNeural',
  rate: 0,
  volume: 0.85,
  maxChars: 120,
};

/** 控制台可选的音色（写死一份，省掉一次联网拉列表；都是 Edge 朗读接口的常用中文音色）。 */
export const VOICES: readonly { value: string; label: string }[] = [
  { value: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 女声（温柔，默认）' },
  { value: 'zh-CN-XiaoyiNeural', label: '晓伊 · 女声（活泼）' },
  { value: 'zh-CN-YunxiNeural', label: '云希 · 男声（少年）' },
  { value: 'zh-CN-YunjianNeural', label: '云健 · 男声（沉稳）' },
  { value: 'zh-CN-YunyangNeural', label: '云扬 · 男声（播音）' },
  { value: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 女声（东北话）' },
  { value: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮 · 女声（陕西话）' },
  { value: 'zh-TW-HsiaoChenNeural', label: '曉臻 · 女声（台湾腔）' },
  { value: 'zh-HK-HiuMaanNeural', label: '曉曼 · 女声（粤语）' },
];

/** 合成成功的一条音频。 */
export interface VoiceClip {
  /** 缓存文件名（`<sha1>.mp3`），桌面端拼成 `<BASE>/voice/<name>` 取回。 */
  name: string;
  /** 播放音量 0~1。 */
  volume: number;
}

/** 对外暴露的运行状态（控制台展示用）。 */
export interface VoiceStatus {
  /** 是否启用。 */
  enabled: boolean;
  /** 当前音色。 */
  voice: string;
  /** 语速百分比。 */
  rate: number;
  /** 音量。 */
  volume: number;
  /** 单句字符上限。 */
  maxChars: number;
  /** 引擎标识。 */
  engine: string;
  /** 缓存里已有多少条音频。 */
  cached: number;
  /** 最近一次失败原因（成功后清空）。 */
  lastError?: string;
  /** 最近一次合成完成的时间戳（毫秒）。 */
  lastAt?: number;
}

/** 语音服务依赖。 */
export interface VoiceDeps {
  /** 日志出口。 */
  log: { info(message: string): void; warn(message: string): void };
  /** 用户数据根目录（缓存落在其下的 voice-cache/）。 */
  userRoot: string;
  /** voice-config.json 的绝对路径。 */
  configPath: string;
  /** 合成完成后回调（宿主据此写 state 叶子）。 */
  onClip: (petId: string, clip: VoiceClip) => void;
}

/** 语音服务。 */
export interface VoiceService {
  config(): VoiceConfig;
  updateConfig(patch: Partial<VoiceConfig>): VoiceConfig;
  status(): VoiceStatus;
  /** 合成（带缓存），返回缓存文件名；失败返回 null，不抛。 */
  synthesize(text: string): Promise<string | null>;
  /** 排队合成并回调：同一只宠物只保留最后一次请求（弹幕刷屏时不追旧句子）。 */
  publish(petId: string, text: string): void;
  /** 缓存文件的绝对路径；名字非法或文件不存在返回 undefined。 */
  filePath(name: string): string | undefined;
  dispose(): void;
}

/** 缓存上限：超过就按修改时间删最旧的，防止长期开播把磁盘吃满。 */
const MAX_CACHE_FILES = 300;
/** 连续失败后的冷却期：这期间不再发请求，避免断网时每句话都卡一次超时。 */
const FAIL_COOLDOWN_MS = 30_000;

/** 缓存文件名白名单：只认 `<40 位十六进制>.mp3`，挡住路径穿越。 */
const CLIP_NAME = /^[a-f0-9]{40}\.mp3$/;

/** 文本里混进替换字符（U+FFFD，编码错乱的痕迹）或控制字符时，合成会返回空音频：先洗掉。
 *  这里就是要匹配控制字符，所以对 no-control-regex 单独放行。 */
// eslint-disable-next-line no-control-regex -- 目标就是控制字符
const JUNK_CHARS = /[\u0000-\u001F\u007F\uFFFD]/g;

/** 数字收敛到 [min, max]，非数字回退 fallback。 */
function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** 语速百分比 → Edge 接口认的 `+10%` / `-10%` 形式。 */
function rateText(rate: number): string {
  return (rate >= 0 ? '+' : '') + String(Math.round(rate)) + '%';
}

/** 创建语音服务。 */
export function createVoiceService(deps: VoiceDeps): VoiceService {
  const { log } = deps;
  const cacheDir = join(deps.userRoot, 'voice-cache');

  let config: VoiceConfig = { ...DEFAULT_VOICE_CONFIG };
  try {
    const parsed = JSON.parse(readFileSync(deps.configPath, 'utf8')) as Partial<VoiceConfig>;
    config = { ...config, ...parsed };
  } catch {
    // 首次运行没有配置文件：用默认值，不打扰用户
  }
  config = normalize(config);

  let lastError: string | undefined;
  let lastAt: number | undefined;
  let cooldownUntil = 0;
  /** 每只宠物待合成的最后一句；同一只被覆盖即视为「旧的那句不用念了」。 */
  const pending = new Map<string, string>();
  let draining: Promise<void> = Promise.resolve();

  /** 把任意来源的 patch 收敛成合法配置。 */
  function normalize(next: VoiceConfig): VoiceConfig {
    const voice = VOICES.some((v) => v.value === next.voice) ? next.voice : DEFAULT_VOICE_CONFIG.voice;
    return {
      enabled: next.enabled !== false,
      voice,
      rate: Math.round(clamp(next.rate, -50, 100, DEFAULT_VOICE_CONFIG.rate)),
      volume: clamp(next.volume, 0, 1, DEFAULT_VOICE_CONFIG.volume),
      maxChars: Math.round(clamp(next.maxChars, 10, 500, DEFAULT_VOICE_CONFIG.maxChars)),
    };
  }

  const persist = (): void => {
    try {
      mkdirSync(deps.userRoot, { recursive: true });
      writeFileSync(deps.configPath, JSON.stringify(config, null, 2), 'utf8');
    } catch (error) {
      log.warn(`[live-pet] 语音配置写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** 清掉超出上限的旧缓存（按 mtime 从旧到新）。 */
  function prune(): void {
    try {
      const files = readdirSync(cacheDir)
        .filter((f) => CLIP_NAME.test(f))
        .map((f) => ({ f, t: statSync(join(cacheDir, f)).mtimeMs }))
        .sort((a, b) => a.t - b.t);
      for (const item of files.slice(0, Math.max(0, files.length - MAX_CACHE_FILES))) {
        unlinkSync(join(cacheDir, item.f));
      }
    } catch {
      // 清理失败不影响合成
    }
  }

  /** 缓存里有几条。 */
  function cachedCount(): number {
    try {
      return readdirSync(cacheDir).filter((f) => CLIP_NAME.test(f)).length;
    } catch {
      return 0;
    }
  }

  /** 文本 → 缓存文件名（纯函数，便于复算）。 */
  function clipName(text: string): string {
    return createHash('sha1').update(`${config.voice}|${config.rate}|${text}`).digest('hex') + '.mp3';
  }

  /** 真正调用引擎合成一次。 */
  async function render(text: string, name: string): Promise<void> {
    const tts = new MsEdgeTTS();
    try {
      await tts.setMetadata(config.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const { audioStream } = tts.toStream(text, { rate: rateText(config.rate) });
      const tmp = join(cacheDir, name + '.part');
      await pipeline(audioStream, createWriteStream(tmp));
      if (!existsSync(tmp) || statSync(tmp).size === 0) {
        // 空音频是「这句话念不出来」（纯符号/乱码），不是网络问题：单独标出来，不触发全局冷却
        unlinkSync(tmp);
        const error = new Error('引擎返回了空音频');
        (error as Error & { code?: string }).code = 'EMPTY_AUDIO';
        throw error;
      }
      renameSync(tmp, join(cacheDir, name));
    } finally {
      try {
        tts.close();
      } catch {
        // 已关闭的连接再 close 会抛，忽略
      }
    }
  }

  async function synthesize(text: string): Promise<string | null> {
    // 先洗掉编码错乱留下的替换字符：它们进 SSML 后引擎会直接返回空音频
    const clean = text.replace(JUNK_CHARS, ' ').trim().slice(0, config.maxChars);
    if (clean === '') return null;
    mkdirSync(cacheDir, { recursive: true });
    const name = clipName(clean);
    const file = join(cacheDir, name);
    if (existsSync(file) && statSync(file).size > 0) return name;
    if (Date.now() < cooldownUntil) return null;
    try {
      await render(clean, name);
      lastError = undefined;
      lastAt = Date.now();
      prune();
      return name;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      lastError = reason;
      // 念不出来（空音频）只影响这一句，不该让整只宠物静音 30 秒
      if ((error as { code?: string }).code !== 'EMPTY_AUDIO') {
        cooldownUntil = Date.now() + FAIL_COOLDOWN_MS;
        log.warn(`[live-pet] 语音合成失败（${FAIL_COOLDOWN_MS / 1000}s 内不再尝试）：${reason}`);
      } else {
        log.info(`[live-pet] 这句念不出来，已跳过：${reason}`);
      }
      return null;
    }
  }

  /** 串行消化待合成队列：一次只合成一条，避免并发连接把 Edge 接口打限流。 */
  async function drain(): Promise<void> {
    while (pending.size > 0) {
      const first = pending.entries().next();
      if (first.done === true) return;
      const [petId, text] = first.value;
      pending.delete(petId);
      const name = await synthesize(text);
      if (name !== null) deps.onClip(petId, { name, volume: config.volume });
    }
  }

  return {
    config(): VoiceConfig {
      return { ...config };
    },
    updateConfig(patch: Partial<VoiceConfig>): VoiceConfig {
      config = normalize({ ...config, ...patch });
      persist();
      // 音色/语速变了，之前的失败冷却也该重来
      cooldownUntil = 0;
      return { ...config };
    },
    status(): VoiceStatus {
      return {
        enabled: config.enabled,
        voice: config.voice,
        rate: config.rate,
        volume: config.volume,
        maxChars: config.maxChars,
        engine: 'msedge-tts',
        cached: cachedCount(),
        ...(lastError === undefined ? {} : { lastError }),
        ...(lastAt === undefined ? {} : { lastAt }),
      };
    },
    synthesize,
    publish(petId: string, text: string): void {
      if (!config.enabled) return;
      if (text.trim() === '') return;
      pending.set(petId, text);
      draining = draining.then(drain, drain);
    },
    filePath(name: string): string | undefined {
      if (!CLIP_NAME.test(name)) return undefined;
      const file = join(cacheDir, name);
      return existsSync(file) ? file : undefined;
    },
    dispose(): void {
      pending.clear();
    },
  };
}
