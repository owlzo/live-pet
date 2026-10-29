/**
 * 点歌指令解析：把一条弹幕文本变成「要搜什么」，不做搜索、不判权限、不碰队列。
 *
 * 认三种写法：`点歌 蓝莲花` / `点歌：蓝莲花` / `点歌蓝莲花`（前缀可配，全角冒号与空格一并吃掉）。
 * 必须始终成立：只认「以任一前缀开头」的整条弹幕——句中带「点歌」二字的普通聊天一律不拦，
 * 否则观众说一句「我点歌单里的歌都听腻了」也会被当成点歌。
 * @module live-pet/src/live/song/command
 */

/** 一条可执行的检索意图。 */
export interface SongCommand {
  /** 检索词（已归一化，保留原始大小写，便于交给搜索接口）。 */
  readonly keyword: string;
  /** 命中的前缀，排障与审计用。 */
  readonly prefix: string;
}

/** 默认前缀。长前缀要排在短前缀之前——`点播` 不能被 `点` 之类的短词先吃掉。 */
export const DEFAULT_SONG_PREFIXES: readonly string[] = ['来一首', '点歌', '点播', '想听', '唱一首'];

/** 检索词长度上限：超过视为普通弹幕（挡住粘贴长文本刷屏）。 */
export const MAX_SONG_KEYWORD_LENGTH = 40;

/** 零宽字符与 BOM：复制粘贴常见的隐形污染，先洗掉。 */
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;

/** 前缀后面允许出现的分隔符（半角/全角空格、冒号、逗号、顿号、点、破折号、书名号与引号）。 */
const LEADING_SEPARATORS = /^[\s:：,，、.。\-—_~～《》「」『』【】"'“”‘’]+/;

/** 检索词尾部的标点与空白（问号感叹号也算，观众常写成「点歌 蓝莲花！！」）。 */
const TRAILING_JUNK = /[\s:：,，、.。!！?？~～\-—_《》「」『』【】"'“”‘’]+$/;

/** 归一化：NFKC 把全角字母数字压成半角，再洗掉零宽字符。 */
function normalizeText(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE, '').trim();
}

/** 去掉前缀后的检索词；不合法返回空串。 */
function cleanKeyword(rest: string): string {
  return rest.replace(LEADING_SEPARATORS, '').replace(TRAILING_JUNK, '').trim();
}

/** 检索词是否可用：非空、不超长、至少含一个可见的非标点字符。 */
function keywordUsable(keyword: string): boolean {
  if (keyword === '' || keyword.length > MAX_SONG_KEYWORD_LENGTH) return false;
  // 全是标点（「点歌 ？？？」）不当作有效请求，交给普通弹幕流程
  return /[\p{L}\p{N}]/u.test(keyword);
}

/**
 * 解析一条弹幕。
 *
 * @param text - 弹幕原文。
 * @param prefixes - 前缀表（缺省 {@link DEFAULT_SONG_PREFIXES}）；内部按长度降序匹配。
 * @returns 命中返回检索意图；不是点歌指令返回 null。
 */
export function parseSongCommand(
  text: string,
  prefixes: readonly string[] = DEFAULT_SONG_PREFIXES,
): SongCommand | null {
  const normalized = normalizeText(text);
  if (normalized === '') return null;
  // 长的先试：`来一首` 命中后就不该再让 `想听` 之类短前缀参与（两者不会同时成立，但顺序更稳）
  const ordered = [...prefixes].filter((p) => p !== '').sort((a, b) => b.length - a.length);
  for (const prefix of ordered) {
    if (!normalized.startsWith(prefix)) continue;
    const keyword = cleanKeyword(normalized.slice(prefix.length));
    return keywordUsable(keyword) ? { keyword, prefix } : null;
  }
  return null;
}

/**
 * 歌名归一化：用于「同一首歌」的比较，不用于搜索。
 *
 * 去掉空白、标点、括号内容（`(Live)`、`【伴奏】`）与常见后缀，统一小写。
 * 必须始终成立：结果只做相等比较，不参与任何展示。
 */
export function normalizeSongKey(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[（([【].*?[)）\]】]/g, '')
    .replace(/[\s\-—_·.,，、:：'"“”‘’!！?？~～&+]/g, '')
    .trim();
}
