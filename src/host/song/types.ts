/**
 * 点歌领域的数据形状：候选曲目、请求单、配置与对外状态。
 *
 * 只有类型与默认值，不含逻辑——守卫、队列、服务与路由都从这里取形状，避免各写一份。
 * 必须始终成立：这些结构会直接落到 HTTP 响应里，字段只增不改（改名等于接口变更）。
 * @module live-pet/src/host/song/types
 */

/** 一条搜索命中的候选曲目（网易云搜索接口的最小投影）。 */
export interface SongCandidate {
  /** 平台歌曲 id（纯数字字符串，投递协议时直接使用）。 */
  readonly id: string;
  /** 歌名。 */
  readonly title: string;
  /** 歌手，多个用 ` / ` 连接。 */
  readonly artist: string;
  /** 时长（毫秒）；接口没给或为 0 时按 0 处理，队列会自动降级为「靠标题变化推进」。 */
  readonly durationMs: number;
}

/** 请求在系统里的生命周期状态。 */
export type SongRequestStatus =
  /** 已入队，等待轮到。 */
  | 'pending'
  /** 已投递播放命令，等待观测确认。 */
  | 'requesting'
  /** 已确认在播。 */
  | 'playing'
  /** 正常播完（或被主播切走）。 */
  | 'ended'
  /** 播放失败并已跳过。 */
  | 'failed';

/** 拒绝/失败原因（对外的窄联合，前端按它给文案）。 */
export type SongReason =
  | 'not-found'
  | 'banned-word'
  | 'blacklist-song'
  | 'blacklist-artist'
  | 'too-long'
  | 'unverified'
  | 'duplicate'
  | 'cooldown'
  | 'quota'
  | 'queue-full'
  | 'play-failed'
  | 'no-client'
  | 'disabled'
  | 'paused';

/** 守卫结论：放行 / 待人工复核 / 拒绝。 */
export type SongVerdict = 'allow' | 'review' | 'block';

/** 一条点歌请求。 */
export interface SongRequest {
  /** 自增序号，控制台与回执都用它定位。 */
  readonly id: number;
  /** 点歌人昵称（抖音没有稳定用户 id，只能按昵称做配额）。 */
  readonly user: string;
  /** 观众原话（已 trim，未归一化）。 */
  readonly raw: string;
  /** 命中的曲目；被拒时可能只有部分字段。 */
  readonly song?: SongCandidate;
  /** 生命周期状态。 */
  status: SongRequestStatus;
  /** 拒绝或失败原因。 */
  reason?: SongReason;
  /** 守卫结论。 */
  readonly verdict: SongVerdict;
  /** 守卫依据（命中的规则名或白名单标记），只用于展示与审计。 */
  readonly note?: string;
  /** 入队时刻（毫秒）。 */
  readonly createdAt: number;
  /** 开始投递的时刻。 */
  startedAt?: number;
  /** 结束（播完/失败）的时刻。 */
  endedAt?: number;
  /** 实际的播放命令投递时刻：状态机据此判断「确认窗口」是否已过。 */
  dispatchedAt?: number;
  /** 已经重投过几次（最多一次）。 */
  retries?: number;
}

/** 守卫配置。 */
export interface SongGuardConfig {
  /** fail-closed = 无法判定时拒绝（默认）；fail-open = 无法判定时放行进复核。 */
  mode: 'fail-closed' | 'fail-open';
  /** 明确可播的歌曲 id（平台曲库 / 已获授权）。 */
  whitelistSongIds: string[];
  /** 明确不可播的歌曲 id。 */
  blacklistSongIds: string[];
  /** 艺人黑名单：艺人名包含即命中。 */
  blacklistArtists: string[];
  /** 内容安全词：歌名或艺人命中即拒。 */
  bannedWords: string[];
  /** 超过这个时长直接拒（DJ 串烧、整场录音）；0 = 不限制。 */
  rejectOverSec: number;
}

/** 队列参数。 */
export interface SongQueueConfig {
  /** 待播上限，同时也是「接单量」的硬顶。 */
  maxPending: number;
  /** 同一用户两次点歌的最小间隔（秒）。 */
  perUserCooldownSec: number;
  /** 同一用户每小时最多几首。 */
  perUserMaxPerHour: number;
  /** 同一首歌的去重窗口（秒）：窗口内重复点同一首直接拒。 */
  duplicateWindowSec: number;
}

/** 播放与观测参数。 */
export interface SongPlaybackConfig {
  /** 单曲最长播放时长（秒），到点强制切歌；0 = 不截断。 */
  playLimitSec: number;
  /** 投递后等多久去观测确认（毫秒）。 */
  verifyDelayMs: number;
  /** 观测轮询间隔（毫秒）。 */
  pollIntervalMs: number;
  /** 播完之后额外等待的缓冲（毫秒），避免把尾奏切掉。 */
  tailMs: number;
}

/** 网易云客户端适配参数。 */
export interface SongNeteaseConfig {
  /** 客户端可执行文件路径；空串 = 从注册表解析。 */
  exePath: string;
  /** 宿主启动时预热客户端（不投递命令）。 */
  autoLaunch: boolean;
  /** 预热时最小化启动。 */
  launchMinimized: boolean;
  /** 两次投递之间的最小间隔（毫秒）。 */
  commandGapMs: number;
}

/** 播报参数。 */
export interface SongAnnounceConfig {
  /** 是否让桌宠念出来。 */
  enabled: boolean;
  /** 报幕与投递之间的间隔（毫秒）：先念完再起歌，避免两条音频叠在一起。 */
  delayMs: number;
}

/** 完整配置（持久化在 `<userRoot>/song-config.json`）。 */
export interface SongConfig {
  /** 总开关：关掉后点歌当作普通弹幕。 */
  enabled: boolean;
  /** 是否接单（临时停单不动总开关）。 */
  accepting: boolean;
  netease: SongNeteaseConfig;
  guard: SongGuardConfig;
  queue: SongQueueConfig;
  playback: SongPlaybackConfig;
  announce: SongAnnounceConfig;
}

/** 默认配置：全关、fail-closed、队列 10 首。 */
export const DEFAULT_SONG_CONFIG: SongConfig = {
  enabled: false,
  accepting: true,
  netease: {
    exePath: '',
    autoLaunch: false,
    launchMinimized: true,
    commandGapMs: 400,
  },
  guard: {
    mode: 'fail-closed',
    whitelistSongIds: [],
    blacklistSongIds: [],
    blacklistArtists: [],
    bannedWords: [],
    rejectOverSec: 600,
  },
  queue: {
    maxPending: 10,
    perUserCooldownSec: 300,
    perUserMaxPerHour: 3,
    duplicateWindowSec: 1800,
  },
  playback: {
    playLimitSec: 240,
    verifyDelayMs: 3000,
    pollIntervalMs: 5000,
    tailMs: 1500,
  },
  announce: {
    enabled: true,
    delayMs: 2500,
  },
};

/** 客户端健康度。 */
export interface SongClientHealth {
  /** 进程是否在跑。 */
  running: boolean;
  /** 当前窗口标题（`歌名 - 歌手`）；拿不到为空串。 */
  title: string;
  /** 最近一次探测失败的原因。 */
  lastError?: string;
  /** 最近一次探测的时刻（毫秒）。 */
  checkedAt?: number;
}

/** `/song/status` 的响应体。 */
export interface SongStatusView {
  enabled: boolean;
  accepting: boolean;
  /** 正在播的那条（含 requesting 阶段）。 */
  playing: SongRequest | null;
  /** 待播队列（不含正在播的）。 */
  pending: SongRequest[];
  /** 累计计数。 */
  counts: {
    accepted: number;
    played: number;
    failed: number;
    rejected: number;
  };
  client: SongClientHealth;
  /** 最近一次错误（成功推进后清空）。 */
  lastError?: string;
}
