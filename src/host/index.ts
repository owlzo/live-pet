/**
 * 插件入口：把宿主半侧的配置、路由、轮询与桌面 Helper 装配到 ctx。
 *
 * 本机版（live-pet）已剥离 DSH 的会话事件、斜杠命令与系统通知，只保留：
 * 配置、素材、轮询状态、余额、碎碎念、对话、桌面窗口。
 * 装配顺序不能改：`getHandlePetRoute` 惰性取用（`httpRoute` 在本函数后段才创建），`startHelper` 必须最后调用。
 * @module live-pet/src/host/index
 */
import { createHostSetup } from './plugin/setup.ts';
import { createHttpRoute, registerHttpRoute } from './plugin/http-route.ts';
import { registerLifecycle } from './plugin/lifecycle.ts';
import { registerLoops } from './plugin/loops.ts';
import { createDesktopHelper } from './plugin/desktop-helper.ts';
import { createBalancePoll } from './plugin/balance-poll.ts';
import { createChatMemory } from './plugin/chat-memory.ts';
import { createPetLookup } from './plugin/pet-lookup.ts';
import { createDownloadReport } from './plugin/download-report.ts';
import { createWorkStatusBridge } from './plugin/work-status-bridge.ts';
import { createLiveService } from '../live/index.ts';
import { createLiveHandler } from '../live/handlers.ts';
import { createVoiceService } from './voice/index.ts';
import { readAllConfig } from './config.ts';
import { join } from 'node:path';
import type { PetRouteDeps } from './routes/types.ts';

/** 插件 id：日志与配置目录标识。 */
export const name = 'live-pet';
/** 不再注入任何宿主服务：本机版的依赖全部来自 createStandaloneContext。 */
export const inject: string[] = [];

/**
 * 宿主插件主体：注册 `/live-pet` 前缀路由与周期轮询。
 * @param ctx - 本机上下文（路由注册、logger、effect、provide）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 本机上下文由 standalone/context 动态构造，无静态类型
export function apply(ctx: any): void {
  const setup = createHostSetup(ctx);
  const {
    userRoot,
    log,
    configPaths,
    thumbUserRoot,
    memeDirsFor,
    standaloneAiPolicy,
    state,
    playback,
    workStatus,
    EXTERNAL_WORK_SESSION,
    nextExternalWorkSeq,
  } = setup;

  // 工作状态容器保留：路由与桌面渲染端仍按同一形状读取，只是本机版不再有会话事件去写它。
  const workStatusBridge = createWorkStatusBridge({ state, workStatus });
  const { publishWorkStatus, stopWorkStatusFlush } = workStatusBridge;
  const downloadReport = createDownloadReport({
    EXTERNAL_WORK_SESSION,
    nextExternalWorkSeq,
    publishWorkStatus,
    workStatus,
  });
  const { reportDownload, stopDownloadSlotTimer } = downloadReport;
  const petLookup = createPetLookup({ state });
  const { lock } = petLookup;
  const chatMemory = createChatMemory({ ctx, configPaths, log, memeDirsFor, state, userRoot });
  const { lastWhisperAt, publishWhisper, chatWithPet, getActivePetId } = chatMemory;

  const balancePoll = createBalancePoll({ ctx, configPaths, getActivePetId, log, state });
  const { effectivePetList, balancePeriodSec, whisperPeriodSec, refreshBalance } = balancePoll;

  // 直播接入：连本地 WS 转发器 → 归一化 → 去重 → 动作映射。
  // AI 未启用时弹幕只记日志、不弹气泡（避免每条都报「没配模型」）。
  const live = createLiveService({
    log,
    configPath: join(userRoot, 'live-config.json'),
    onEvent: createLiveHandler({
      log,
      state,
      // 单机模式没有 /pet 命令设置「当前宠物」：空串会写进没人消费的 pets['']，
      // 这里退回到第一只生效宠物，保证气泡一定落在看得见的那只身上。
      petId: () => {
        const list = effectivePetList();
        const active = getActivePetId();
        // 当前选中的宠物可能已被删除（控制台删宠物不会清 activePetId）：必须校验它还在列表里，
        // 否则事件会写进一个渲染端不认识的 id，气泡静默丢失。
        if (active !== '' && list.some((pet) => String(pet.id) === active)) return active;
        return String(list[0]?.id ?? 'main');
      },
      pickAnim: (pool) => {
        try {
          const cfg = readAllConfig(configPaths);
          const main = cfg.main as { animations?: Record<string, unknown> } | undefined;
          const list = main?.animations?.[pool];
          if (!Array.isArray(list) || list.length === 0) return undefined;
          return String(list[Math.floor(Math.random() * list.length)]);
        } catch {
          return undefined;
        }
      },
      chat: (petId, text) => chatWithPet(petId, text),
      chatEnabled: () => standaloneAiPolicy()?.isReady() === true,
    }),
  });
  ctx.effect(() => () => live.dispose(), 'live-pet: live service');

  // 宠物语音：弹幕、碎碎念、对话回复、/broadcast 最终都走 state.writePet(petId,'say',…) 这一个口子，
  // 在这里拦一刀交给 TTS 合成，气泡照旧立刻出现、声音晚几百毫秒跟上（合成是异步的）。
  // 只在 say 上触发：anim / position / throw 是动作指令，不念。
  const voice = createVoiceService({
    log,
    userRoot,
    configPath: join(userRoot, 'voice-config.json'),
    onClip: (petId, clip) => state.writePet(petId, 'voice', clip),
  });
  const writePetRaw = state.writePet.bind(state);
  state.writePet = (petId, leaf, data) => {
    writePetRaw(petId, leaf, data);
    if (leaf !== 'say' || data === null || typeof data !== 'object') return;
    const say = data as { text?: unknown; duration?: unknown; clear?: unknown };
    // clear 是「收起气泡」，duration=0 是「只播动画不弹泡」——两种都不出声
    if (say.clear === true || say.duration === 0) return;
    if (typeof say.text !== 'string' || say.text.trim() === '') return;
    voice.publish(petId, say.text);
  };
  ctx.effect(() => () => voice.dispose(), 'live-pet: voice service');


  const desktopHelper = createDesktopHelper({
    ctx,
    configPaths,
    effectivePetList,
    log,
    reportDownload,
    thumbUserRoot,
    // 惰性取用：handlePetRoute 在下方装配，Helper 只在启动/收请求时才真正调用它
    getHandlePetRoute: () => httpRoute.handlePetRoute,
  });
  const { startHelper, stopHelper, markDisposed } = desktopHelper;

  const deps: PetRouteDeps = {
    ...setup,
    ...petLookup,
    ...workStatusBridge,
    ...chatMemory,
    ...balancePoll,
    ...desktopHelper,
    // 对话能力由 routes/chat 使用；命令层删除后仍需显式带上，避免依赖表漏项
    chatWithPet,
    live,
    voice,
    ctx,
  };
  const httpRoute = createHttpRoute(deps);
  registerHttpRoute(ctx, httpRoute.handlePetRoute);

  // 余额与碎碎念的周期轮询（本机版保留：余额按服务商档位、碎碎念按人设生成）。
  registerLoops({
    ctx,
    balancePeriodSec,
    configPaths,
    lastWhisperAt,
    lock,
    log,
    publishWhisper,
    refreshBalance,
    standaloneAiPolicy,
    whisperPeriodSec,
  });

  registerLifecycle({
    ctx,
    lock,
    markDisposed,
    playback,
    state,
    stopDownloadSlotTimer,
    stopHelper,
    stopWorkStatusFlush,
  });

  // 路由就绪后拉起桌面窗口（Electron 缺失时仅告警，不影响服务）
  startHelper();
}
