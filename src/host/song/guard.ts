/**
 * 点歌守卫：在入队之前给出「能不能播」的结论，纯函数、无 IO、可单测。
 *
 * 判定顺序有意固定：内容安全 → 黑名单（曲目/艺人）→ 白名单 → 时长 → 默认策略。
 * 黑名单先于白名单，是因为「明确不能播」必须是硬红线，不能被一份过期的白名单盖过去。
 * 必须始终成立：**无法判定时不能默认放行**（fail-closed），且结论必须带得出依据（note），
 * 否则控制台上主播看到的就是一个无法解释的拒绝。
 * @module live-pet/src/host/song/guard
 */

import type { SongCandidate, SongGuardConfig, SongReason, SongVerdict } from './types.ts';

/** 一次判定的结果。 */
export interface SongGuardDecision {
  verdict: SongVerdict;
  /** 拒绝或待复核的原因；allow 时不带。 */
  reason?: SongReason;
  /** 给人和日志看的依据，永远非空。 */
  note: string;
}

/** 归一化比较键：全角转半角、小写、去掉空白与常见分隔符。 */
function fold(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-—_·.,，、:：'"“”‘’!！?？~～&+()（）[\]【】]/g, '');
}

/** 在若干段文本里找第一个命中的词；没有返回 undefined。 */
function firstHit(words: readonly string[], texts: readonly string[]): string | undefined {
  for (const word of words) {
    const needle = fold(word);
    if (needle === '') continue;
    for (const text of texts) {
      if (fold(text).includes(needle)) return word;
    }
  }
  return undefined;
}

/** 判定输入。 */
export interface SongGuardInput {
  /** 搜索命中的曲目。 */
  readonly candidate: SongCandidate;
  /** 观众输入的原始检索词：也要过一遍敏感词，避免「搜索词干净、歌名脏」的反向漏网。 */
  readonly keyword?: string;
  /** 守卫配置。 */
  readonly config: SongGuardConfig;
}

/**
 * 给一条候选曲目定性。
 *
 * @param input - 曲目、原始检索词与配置。
 * @returns 判定结论；`verdict` 为 `block` 时带 `reason`。
 */
export function judgeSong(input: SongGuardInput): SongGuardDecision {
  const { candidate, keyword, config } = input;
  const texts = [candidate.title, candidate.artist, keyword ?? ''];

  // 1) 内容安全：与版权正交，命中即拒，不看任何白名单
  const banned = firstHit(config.bannedWords, texts);
  if (banned !== undefined) {
    return { verdict: 'block', reason: 'banned-word', note: `命中敏感词「${banned}」` };
  }

  // 2) 曲目黑名单：精确 id，最具体的一档
  if (config.blacklistSongIds.includes(candidate.id)) {
    return { verdict: 'block', reason: 'blacklist-song', note: `曲目 id ${candidate.id} 在黑名单` };
  }

  // 3) 艺人黑名单：包含匹配（`周杰伦` 要能挡住 `周杰伦 / 方文山` 这种拼接）
  const artist = firstHit(config.blacklistArtists, [candidate.artist]);
  if (artist !== undefined) {
    return { verdict: 'block', reason: 'blacklist-artist', note: `艺人「${artist}」在黑名单` };
  }

  // 4) 白名单：平台曲库或已获授权的曲目，跳过后续风险判定
  if (config.whitelistSongIds.includes(candidate.id)) {
    return { verdict: 'allow', note: '命中白名单' };
  }

  // 5) 时长硬上限：整场录音、DJ 串烧这类一律拒
  if (config.rejectOverSec > 0 && candidate.durationMs > config.rejectOverSec * 1000) {
    const minutes = Math.round(candidate.durationMs / 60000);
    return { verdict: 'block', reason: 'too-long', note: `时长约 ${minutes} 分钟，超过单曲上限` };
  }

  // 6) 默认策略：未知版权状态
  return config.mode === 'fail-closed'
    ? { verdict: 'block', reason: 'unverified', note: '未在白名单内（fail-closed）' }
    : { verdict: 'review', reason: 'unverified', note: '未在白名单内，放行待主播复核（fail-open）' };
}

/**
 * 配置收敛：外部写进来的数组与数值一律洗一遍。
 *
 * 空串与纯空白条目直接丢弃——控制台的多行文本框很容易留下空行，
 * 留着一个空串会让 `includes('')` 变成「匹配一切」。
 */
export function normalizeGuardConfig(raw: Partial<SongGuardConfig> | undefined, fallback: SongGuardConfig): SongGuardConfig {
  const cleanList = (value: unknown, fallbackList: string[]): string[] => {
    if (!Array.isArray(value)) return [...fallbackList];
    const out: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed);
    }
    return out;
  };
  const mode = raw?.mode === 'fail-open' || raw?.mode === 'fail-closed' ? raw.mode : fallback.mode;
  const rejectOverSec = Number(raw?.rejectOverSec);
  return {
    mode,
    whitelistSongIds: cleanList(raw?.whitelistSongIds, fallback.whitelistSongIds),
    blacklistSongIds: cleanList(raw?.blacklistSongIds, fallback.blacklistSongIds),
    blacklistArtists: cleanList(raw?.blacklistArtists, fallback.blacklistArtists),
    bannedWords: cleanList(raw?.bannedWords, fallback.bannedWords),
    rejectOverSec: Number.isFinite(rejectOverSec) && rejectOverSec >= 0 ? Math.min(7200, rejectOverSec) : fallback.rejectOverSec,
  };
}
