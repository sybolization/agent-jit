/**
 * submit_answer：双 arm 完全同标准的最终答案提交通道。
 *
 * 为什么需要它（P0 review）：旧实现把"最后一次成功程序的整个 result JSON + finalText"拼成
 * haystack 做 oracle 子串判定——B 型错误程序（dslCorrect=false）的 result 恰好包含三个目标
 * repo 名，于是被误判 answerCorrect=true。改为结构化提交后，答案只来自模型显式提交的
 * answer 参数（未提交时退回 finalText），错误程序的 result 永不进入答案判定。
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

import { defineTool, type RegisteredTool } from "../../tools/definition.js";

export const SUBMIT_ANSWER_ID = "submit_answer";

export const submitAnswerTool: RegisteredTool = {
  ...defineTool({
    id: SUBMIT_ANSWER_ID,
    label: "Submit final answer",
    description:
      "提交任务的最终答案。完成所有工具调用后，调用本工具一次，把完整最终答案放在 answer 参数里；这是最终答案的唯一提交通道。",
    inputSchema: Type.Object({ answer: Type.String() }, { additionalProperties: false }),
    outputSchema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }),
  }),
  execute: async () => ({ ok: true }),
};

/**
 * submit_answer 的 AgentTool 版本。stopAfterSubmit=true 时 execute 返回 terminate: true，
 * pi-ai agent loop 会在该批工具执行完后直接结束（不再进模型 final 轮）——用于去掉
 * "submit 后仍生成最终文本" 的协议冗余；false 时行为与 adaptRegisteredTool 一致。
 */
export function createR5SubmitTool(stopAfterSubmit: boolean): AgentTool<any> {
  return {
    name: SUBMIT_ANSWER_ID,
    label: submitAnswerTool.label,
    description: submitAnswerTool.description ?? submitAnswerTool.label,
    parameters: submitAnswerTool.inputSchema,
    execute: async () => ({
      content: [{ type: "text", text: '{"ok":true}' }],
      details: {},
      ...(stopAfterSubmit ? { terminate: true } : {}),
    }),
  };
}
