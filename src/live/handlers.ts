/**
 * 直播事件 → 宠物动作的映射：弹幕走大模型，礼物/进场/点赞走固定文案与动画。
 *
 * 只做映射与写状态；不建连接、不去重、不排队（那三层在 ./index 与 ./queue）。
 * 必须始终成立：任何失败都只写日志，不抛出——一条弹幕炸掉不能拖垮整条接入链路。
 *
 * 返回值的用途：**返回「这次实际念出去的文本」**，队列据此估算这条要念多久，
 * 从而决定下一条什么时候播（见 ./index 的 pump）。返回 undefined = 这条没出声。
 * @module live-pet/src/live/handlers
 */
import type { PollStateStore } from '../host/state.ts';
import type { LiveEvent, LiveMode } from './types.ts';

/** 动作映射依赖。 */
export interface LiveHandlerDeps {
  log: { info(message: string): void; warn(message: string): void };
  /** 轮询状态存储：写 pets.<id>.say / .anim 就是让桌宠开口/播动画。 */
  state: PollStateStore;
  /** 当前目标宠物 id（多开时取第一只）。 */
  petId: () => string;
  /** 从配置里取某类动画池（clicks / idle），随机挑一个。 */
  pickAnim: (pool: 'clicks' | 'idle') => string | undefined;
  /** 弹幕回复；未配置模型时返回 ok:false，不弹气泡。 */
  chat: (petId: string, text: string) => Promise<{ ok: boolean; text?: string; reason?: string }>;
  /** 弹幕是否走大模型（AI 未启用时关掉，避免每条都报错）。 */
  chatEnabled: () => boolean;
  /**
   * 点歌入口（可选）：命中点歌指令时返回「要播报的那句话」，否则 undefined。
   *
   * 必须排在 readonly 回显与模型调用之前——否则单机模式会把指令当成普通弹幕念出来，
   * AI 模式会拿指令去问模型。返回值同时决定队列给这一条排多长的播报间隔。
   */
  song?: (user: string, text: string) => Promise<string | undefined> | string | undefined;
}

/** 说一句话（与 /broadcast 写同一个叶子，渲染端无需区分来源）。 */
function say(state: PollStateStore, petId: string, text: string, duration = 8000): void {
  state.writePet(petId, 'say', { text, duration, anim: true });
}

/** 播一段动画。 */
function play(state: PollStateStore, petId: string, name: string | undefined): void {
  if (name !== undefined && name !== '') state.writePet(petId, 'anim', { name });
}

/** 创建事件处理器（返回的函数直接交给 LiveService 的 onEvent）。 */
export function createLiveHandler(
  deps: LiveHandlerDeps,
): (event: LiveEvent, mode: LiveMode) => Promise<string | undefined> {
  return async (event: LiveEvent, mode: LiveMode): Promise<string | undefined> => {
    const petId = deps.petId();
    try {
      switch (event.kind) {
        case 'chat': {
          // 点歌指令先过一道：它属于「命令」而不是「聊天」，两种模式都不该走回显或模型。
          // 未命中时返回 undefined，下面照旧走原来的两条分支。
          if (deps.song !== undefined) {
            const handled = await deps.song(event.user, event.text ?? '');
            if (handled !== undefined && handled !== '') {
              say(deps.state, petId, handled, 6000);
              deps.log.info(`[live-pet] 点歌指令 ${event.user}：${event.text ?? ''} → ${handled}`);
              return handled;
            }
          }
          // 单机模式：只读弹幕——把「谁说了什么」原样显示，不调用任何模型。
          if (mode === 'readonly') {
            const line = event.user + '：' + (event.text ?? '');
            say(deps.state, petId, line, 6000);
            deps.log.info(`[live-pet] 弹幕（只读）${event.user}：${event.text ?? ''}`);
            return line;
          }
          if (!deps.chatEnabled()) {
            deps.log.info(`[live-pet] 弹幕已收到但未启用 AI：${event.user}：${event.text ?? ''}`);
            return undefined;
          }
          const reply = await deps.chat(petId, event.text ?? '');
          if (reply.ok && reply.text !== undefined && reply.text !== '') {
            say(deps.state, petId, reply.text, 10000);
            deps.log.info(`[live-pet] 弹幕 ${event.user} → 回复：${reply.text}`);
            return reply.text;
          }
          deps.log.warn(`[live-pet] 弹幕回复失败 reason=${reply.reason ?? 'unknown'}`);
          return undefined;
        }
        case 'gift': {
          // 礼物感谢是固定话术，两种模式都走这里（不经过模型，单机模式也能用）。
          const name = event.giftName ?? '礼物';
          const count = event.giftCount ?? 1;
          const line = '谢谢 ' + event.user + ' 的 ' + name + (count > 1 ? ' ×' + count : '') + '！';
          say(deps.state, petId, line, 8000);
          play(deps.state, petId, deps.pickAnim('clicks'));
          deps.log.info(`[live-pet] 礼物 ${event.user} × ${name}(${count})`);
          return line;
        }
        case 'enter': {
          // 单机模式不欢迎进场：人一多会刷屏，只留日志。
          if (mode === 'readonly') {
            deps.log.info(`[live-pet] 进场（只读）${event.user}`);
            return undefined;
          }
          const line = '欢迎 ' + event.user + ' 来到直播间～';
          say(deps.state, petId, line, 6000);
          play(deps.state, petId, deps.pickAnim('idle'));
          deps.log.info(`[live-pet] 进场 ${event.user}`);
          return line;
        }
        case 'follow': {
          if (mode === 'readonly') {
            deps.log.info(`[live-pet] 关注（只读）${event.user}`);
            return undefined;
          }
          const line = '谢谢 ' + event.user + ' 的关注！';
          say(deps.state, petId, line, 6000);
          play(deps.state, petId, deps.pickAnim('clicks'));
          deps.log.info(`[live-pet] 关注 ${event.user}`);
          return line;
        }
        case 'like': {
          // 点赞量大且无正文：只播动画，不说话（去重层已压掉同一用户的重复点赞）
          // 单机模式连动画都不播——点赞是最高频事件，会把随机链顶掉。
          if (mode === 'readonly') return undefined;
          play(deps.state, petId, deps.pickAnim('idle'));
          deps.log.info(`[live-pet] 点赞 ${event.user}`);
          return undefined;
        }
      }
    } catch (error) {
      deps.log.warn(`[live-pet] 直播事件映射失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  };
}
