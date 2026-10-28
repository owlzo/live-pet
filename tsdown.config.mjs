// tsdown 配置：本机版只有两个入口。
//
//   1) 宿主半侧（index → lib/index.js）—— ESM，供 app 与测试直接 import。
//   2) 桌面应用（app → lib/app.js）—— 同一个 Electron 进程里跑「本机服务 + 宿主半侧 + 桌面窗口」。
//      electron 由 Electron 自己的模块加载器提供；zod / openai / @anthropic-ai/sdk / msedge-tts 必须打进包，
//      因为 electron-builder 的 files 白名单不带 node_modules，留成裸 import 就会 ERR_MODULE_NOT_FOUND。
//      msedge-tts 还带 axios / ws 等传递依赖，一并内联，否则打包版会在语音这一步才炸。
import { defineConfig } from 'tsdown';

/** 两份配置共用的编译口径 */
const shared = {
  format: ['esm'],
  platform: 'node',
  target: 'es2020',
  dts: false,
  outDir: 'lib',
  clean: false,
};

export default defineConfig([
  {
    ...shared,
    // 与 app 同口径：Node ≥ 22 直接吃 es2022。es2020 会把 class field 降级成
    // @oxc-project/runtime 的 helper，而那个包不在依赖里（产物会 ERR_MODULE_NOT_FOUND）。
    target: 'es2022',
    entry: {
      index: 'src/host/index.ts',
    },
    external: [/^node:/],
  },
  {
    ...shared,
    // 应用入口跑在 Electron 的 Node ≥ 22 上，可以到 es2022：
    // es2020 目标会把 class field 降级成 @oxc-project/runtime 的 helper，那个包不在依赖里。
    target: 'es2022',
    entry: {
      app: 'src/app/main.ts',
    },
    noExternal: [/^zod$/, /^openai$/, /^@anthropic-ai\/sdk$/, /^msedge-tts$/, /^axios$/, /^ws$/, /^isomorphic-ws$/, /^buffer$/],
    external: ['electron', /^node:/],
  },
]);
