/**
 * 模型调用契约：消息工厂、流式文本块拼装与 reasoning 标识。
 *
 * 本文件是宿主半侧唯一与模型 SDK 形状打交道的地方；上层（chat / whisper）只依赖这里的形状。
 * 不发起请求、不读配置：真正调用在 standalone/ai-provider 与 llm-call。
 * 必须始终成立：push 只接受 `{ type: 'text' }`，其他块（reasoning、工具调用）一律丢弃。
 * @module live-pet/src/host/llm-contract
 */

/** 一条对话消息的最小形状：角色、内容与来源。 */
export interface LlmMessage {
  role: 'user' | 'assistant';
  content: unknown;
  source: unknown;
}

/** 创建用户消息。 */
export function createUserMessage(input: { content: unknown; source: unknown }): LlmMessage {
  return { role: 'user', content: input.content, source: input.source };
}

/** 创建助手消息。 */
export function createAssistantMessage(input: { content: unknown; source: unknown }): LlmMessage {
  return { role: 'assistant', content: input.content, source: input.source };
}

/** 文本块形状。 */
export interface TextBlock {
  type: 'text';
  text: string;
}

/** 流式文本拼装：把增量文本块累积成最终文本。 */
export class BlockAssembler {
  /** 已收集的文本片段。 */
  private readonly chunks: string[] = [];

  /** 流结束原因：调用方在结束时写入；未写入（null）时按「模型未返回文本」处理。 */
  finish: { kind: 'stop' | 'aborted' | 'max-tokens' | 'error'; failure?: { message?: string; code?: string } } | null =
    null;

  /** 收集一个流块；只认文本增量与终止块，其余（reasoning、工具调用）忽略。 */
  push(chunk: unknown): void {
    if (chunk === null || typeof chunk !== 'object') return;
    const c = chunk as { type?: unknown; text?: unknown; reason?: unknown };
    // 两种文本块：整块（text）与增量（text-delta）。真实模型流发的是后者。
    if (c.type === 'text' || c.type === 'text-delta') {
      if (typeof c.text === 'string') this.chunks.push(c.text);
      return;
    }
    // 终止块：把 reason 记下来，没出正文时由 noTextReason 报出真实原因（超限 / 报错 / 取消）。
    if (c.type === 'finish') {
      this.finish = (c.reason ?? null) as BlockAssembler['finish'];
    }
  }

  /** 返回当前拼装结果；没有文本时返回空数组（调用方据此判定「模型没说话」）。 */
  blocks(): TextBlock[] {
    const text = this.chunks.join('');
    return text === '' ? [] : [{ type: 'text', text }];
  }
}

/** reasoning effort 标识工厂：原样返回传入值。 */
export function ReasoningEffortId(id: string): string {
  return id;
}
