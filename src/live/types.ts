/**
 * 直播事件的统一形状：抖音/其它平台的差异全部在「源」里抹平，下游只认这五个字段。
 *
 * 不依赖任何宿主或 DOM：去重器、事件总线与动作映射都只吃这个类型，便于单测与替换平台。
 * 必须始终成立：user 与 ts 必有；text 只在 chat 上有意义，giftName/giftCount 只在 gift 上有意义。
 * @module live-pet/src/live/types
 */

/** 接入模式：ai = 弹幕走大模型；readonly = 单机模式，只读弹幕不走模型。 */
export type LiveMode = 'ai' | 'readonly';

/** 直播间事件类型。 */
export type LiveEventKind = 'chat' | 'gift' | 'enter' | 'like' | 'follow';

/** 一条归一化后的直播事件。 */
export interface LiveEvent {
  /** 事件类型。 */
  kind: LiveEventKind;
  /** 发送者昵称（去重键的一部分；平台没给就填 '匿名'）。 */
  user: string;
  /** 弹幕正文（chat 专用）。 */
  text?: string;
  /** 礼物名（gift 专用）。 */
  giftName?: string;
  /** 礼物数量（gift 专用，缺省 1）。 */
  giftCount?: number;
  /** 事件时间戳（毫秒）。 */
  ts: number;
  /** 原始消息，排查映射问题时用；不参与去重。 */
  raw?: unknown;
}

/** 连接状态与计数（控制台直播页直接渲染这份）。 */
export interface LiveStatus {
  /** 当前接入模式。 */
  mode: LiveMode;
  /** 是否已连上转发服务。 */
  connected: boolean;
  /** 当前源地址（脱敏：不带查询串）。 */
  source: string;
  /** 房间号。 */
  room: string;
  /** 收到的原始事件总数（去重前）。 */
  received: number;
  /** 通过去重、真正被处理的事件数。 */
  delivered: number;
  /** 被去重抑制的事件数。 */
  suppressed: number;
  /** 最近一条被放行的事件（控制台展示用）。 */
  lastEvent?: { kind: LiveEventKind; user: string; text?: string; ts: number };
  /** 最近一次错误（连不上 / 解析失败），成功连上后清空。 */
  lastError?: string;
  /** 连接建立时刻（毫秒）。 */
  connectedAt?: number;
}

/** 去重参数：同一用户 + 同一内容在窗口内最多放行 N 次。 */
export interface DedupeOptions {
  /** 窗口长度（毫秒）。 */
  windowMs: number;
  /** 窗口内最多放行次数；超出即抑制。 */
  maxPerWindow: number;
}
