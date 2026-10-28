/**
 * 本机 AI 设置接口的公开出口：设置读写与连通性测试。
 *
 * 只做再导出；应答工具在 ./server/respond，处理器在 ./server/handlers。
 * 必须始终成立：请求体与响应体都有上限，设置页永不回显密钥。
 * @module live-pet/src/standalone/server
 */
export { DEFAULT_STANDALONE_PORT } from './server/options.ts';
export type { StandaloneServer, StandaloneServerOptions } from './server/options.ts';
export { settingsHandler, testHandler } from './server/handlers.ts';
