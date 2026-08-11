#!/usr/bin/env node

/**
 * R5 — Autonomous Offloading：模型自己决定是否把确定性工作 offload 给 JIT。
 *
 * 实验问题：**仅仅给 Agent 多一个 JIT 能力，它会不会自己正确使用？**
 * 因此不再告诉模型"请用 DSL 完成任务"，只告诉它"你拥有普通工具，以及 Agent JIT；
 * 当一段后续工作可以确定性程序化时可以选择 describe + execute，是否使用由你决定"。
 *
 * 两个 arm（其他条件完全一样）：
 * - control：普通 Agent + atomic tools；
 * - treatment：同一个 Agent + 相同 atomic tools + jit_describe_tools + jit_execute_program。
 * 不做 forced-JIT arm（R4 系列已有大量这类结果）。
 *
 * 三类任务（见 src/experiments/r5Tasks.ts）：
 * - A 不值得 JIT（单次调用）；B 明显值得 JIT（批量流水线）；C 混合型（语义判断 + 确定性段）。
 *
 * 新指标（在 task correctness / tokens / round trips / latency 之上）——R5 review 重定义，
 * 不再用单一 path（dsl / ordinary）概括：
 * - jitAttempted / jitExecutionSucceeded / jitSemanticCorrect / jitFinishedWithoutFallback / fallbackUsed / maxedOut
 *   逐项记录（attempted = "想用"，executionSucceeded = "跑通"，semanticCorrect = "用对语义"，
 *   jitFinishedWithoutFallback = "JIT 独立完成"（语义正确且无 fallback））；
 * - adoption rate = jitAttempted 比例；offload precision = semanticCorrect / attempted
 *   （真 precision，分母是尝试过的 run，不是总 run 数）——两个问题分开；
 * - offload 时机（P0：jitCompleted 只反映"是否独立完成"，不反映"是否及时"）：
 *   offloadDecisionRound（第一次 JIT 调用的轮数）+ pre/same/post-execute 三桶业务调用（按 Agent
 *   round 分割，避免同轮并发 describe+业务工具被误判为 fallback）；B 型再统计 preOffloadPipelineCalls（JIT 前已执行掉的、本可 offload
 *   的流水线调用）并据此定义 timelyOffload（= 语义正确 且 preOffloadPipelineCalls === 0）；
 * - 最终答案走结构化 submit_answer（双 arm 同标准），**未提交即判错**，绝不从 finalText /
 *   错误程序的 result 做子串判定（P0：dslCorrect=false 的 run 必须 fail，除非模型用普通工具补救）；
 * - compressed path length：一次 jit_execute_program 实际替代了多少原子操作
 *   （tool nodes + map fanout + compute/merge/concat/filter），并另记 correctlyCompressedOps
 *   ——只统计语义正确程序的压缩数，避免错误 DSL 夸大收益。
 * - C 型支持 --candidates=N（4/10/20/40）做 C-scaling（P2）。
 *
 * 工具调用循环由 pi-agent-core `Agent` 负责（普通工具与 jit_* 都是 AgentTool）——
 * harness 只做观测，对任何工具都没有特殊 dispatch（createPiTools 见 src/integrations/pi）。
 *
 * 运行：npx tsx src/experiments/r5OffloadingBenchmark.ts [--arm=both|control|treatment] [--task=A|B|C|all] [--samples=2] [--rounds=10] [--dsl-guidance=primitive|patterns|full-example]
 * 环境：DEEPSEEK_API_KEY（.env，已被 gitignore）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Type } from "typebox";

import { createDeepSeekPiRuntime, type PiRuntime } from "../llm/gateway.js";
import { adaptRegisteredTool, createPiTools } from "../integrations/pi/toolAdapter.js";
import { type DslGuidanceMode } from "../integrations/pi/dslReference.js";
import type { JitExecuteProgramDetails } from "../integrations/pi/jit.js";
import type { ExecutionGraph } from "../compiler/ir.js";
import type { TraceEntry } from "../runtime/trace.js";
import { defineTool, type RegisteredTool } from "../tools/definition.js";
import { DESCRIBE_TOOLS_TOOL, EXECUTE_PROGRAM_TOOL } from "../tools/jitTools.js";
import { toolIdAlias, ToolRegistry } from "../tools/registry.js";
import { checkTaskCorrectness } from "./taskSpec.js";
import { runPiAgent, type AgentReasoningTurn } from "./agentRunner.js";
import { createR5CTask, R5_TASKS, type R5Task, type R5TaskId } from "./r5Tasks.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

/**
 * submit_answer：双 arm 完全同标准的最终答案提交通道。
 *
 * 为什么需要它（P0 review）：旧实现把“最后一次成功程序的整个 result JSON + finalText”拼成
 * haystack 做 oracle 子串判定——B 型错误程序（dslCorrect=false）的 result 恰好包含三个目标
 * repo 名，于是被误判 answerCorrect=true。改为结构化提交后，答案只来自模型显式提交的
 * answer 参数（未提交时退回 finalText），错误程序的 result 永不进入答案判定。
 */
const SUBMIT_ANSWER_ID = "submit_answer";

const submitAnswerTool: RegisteredTool = {
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

function loadEnv(root: string): void {
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] === undefined) process.env[key] = trimmed.slice(eq + 1).trim();
  }
}

// ---------------------------------------------------------------------------
// 系统提示词（两个 arm 唯一差异：是否告知 JIT 能力）
// ---------------------------------------------------------------------------

/** control 臂：普通 Agent，只有 atomic tools + submit_answer，完全不知道 JIT。 */
export function r5ControlSystemPrompt(): string {
  return [
    "你是一个自主 Agent，需要完成用户交给的任务。",
    "使用提供的工具逐步完成；工具名与参数见工具定义。",
    `完成所有工具调用后，调用 ${SUBMIT_ANSWER_ID}(answer="...") 提交最终答案（最终答案的唯一提交通道，不要只写在普通文本里）。`,
  ].join("\n");
}

/**
 * treatment 臂：普通工具 + Agent JIT；是否 offload 由模型自己决定。
 *
 * 常驻 prompt **极简**（R5 review）：不内嵌 DSL 语法 / 示例 / 使用规则——DSL manual
 * 改为按需加载：jit_describe_tools 第一次调用会随契约返回极简语法参考（见
 * src/integrations/pi/dslReference.ts 的 renderDslReference(guidance)（--dsl-guidance 可选 primitive/patterns/full-example，默认 primitive））。
 * 这样 A 型这种完全不用 JIT 的任务基本不承担 DSL context 成本（控制 context tax 的设计意图）。
 */
export function r5TreatmentSystemPrompt(): string {
  return [
    "你是一个自主 Agent，需要完成用户交给的任务。你有两类工具：",
    "- 普通业务工具：直接调用（工具名与参数见工具定义），适合单次查询/操作。",
    `- Agent JIT：将已经确定的多步工具操作编译执行——需要时先用 ${DESCRIBE_TOOLS_TOOL.name} 获取编程契约（返回 DSL 语法极简参考 + 你要编排工具的契约），再用 ${EXECUTE_PROGRAM_TOOL.name} 提交程序。`,
    "",
    "是否使用 JIT 由你决定：单个查询用普通工具即可；一段后续工作可以确定性程序化（对列表每个元素做同样处理、过滤/排序/合并/取前 N 等）时再考虑 JIT。",
    `完成所有工具调用后，调用 ${SUBMIT_ANSWER_ID}(answer="...") 提交最终答案（最终答案的唯一提交通道，不要只写在普通文本里）。`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// compressed path length：一次 JIT 执行替代了多少原子操作
// ---------------------------------------------------------------------------

export interface CompressedPath {
  toolNodes: number;
  mapNodes: number;
  /** map 的实际展开数（每个元素一次工具调用），来自执行 trace */
  fanoutSum: number;
  computeNodes: number;
  /** merge_by_key（join 节点）数量 */
  mergeNodes: number;
  /** concat 节点数量 */
  concatNodes: number;
  returnNodes: number;
  /** 原子操作总数：tool 节点 + map 展开执行数 + compute/merge/concat/return 各一 */
  atomicOps: number;
}

export function compressedPath(graph: ExecutionGraph, trace: readonly TraceEntry[]): CompressedPath {
  let toolNodes = 0;
  let mapNodes = 0;
  let computeNodes = 0;
  let mergeNodes = 0;
  let concatNodes = 0;
  let returnNodes = 0;
  for (const node of graph.nodes) {
    switch (node.kind) {
      case "tool":
        toolNodes += 1;
        break;
      case "map":
        mapNodes += 1;
        break;
      case "compute":
        computeNodes += 1;
        break;
      case "join":
        mergeNodes += 1;
        break;
      case "concat":
        concatNodes += 1;
        break;
      case "return":
        returnNodes += 1;
        break;
    }
  }
  const fanoutSum = trace.filter((entry) => entry.kind === "map").reduce((sum, entry) => sum + (entry.fanout ?? 0), 0);
  return {
    toolNodes,
    mapNodes,
    fanoutSum,
    computeNodes,
    mergeNodes,
    concatNodes,
    returnNodes,
    atomicOps: toolNodes + fanoutSum + computeNodes + mergeNodes + concatNodes + returnNodes,
  };
}

function matchesOracle(haystack: string, oracle: readonly (string | RegExp)[]): boolean {
  return oracle.every((needle) =>
    typeof needle === "string" ? haystack.includes(needle) : needle.test(haystack),
  );
}

// ---------------------------------------------------------------------------
// 单次运行
// ---------------------------------------------------------------------------

export type R5Arm = "control" | "treatment";

/** 一次工具调用的时间线记录（按首次出现顺序；isError 在执行结束时回填）。 */
export interface R5ToolCallRecord {
  name: string;
  isError: boolean;
  /** 该工具调用发生在第几轮（1-based） */
  round: number;
  /** 工具调用参数（实验阶段完整保留，供 offload 时机 / 重复工作分析） */
  arguments: Record<string, unknown>;
}

export interface R5RunMetrics {
  arm: R5Arm;
  taskId: R5TaskId;
  rounds: number;
  /** 独立字段：是否跑满最大轮数（不再被 executeCalls 掩盖） */
  maxedOut: boolean;
  tokens: { input: number; output: number; cacheRead: number; total: number };
  latencyMs: number;
  /** 完整工具时间线（业务 / jit_describe_tools / jit_execute_program / submit_answer，按序） */
  toolTimeline: readonly R5ToolCallRecord[];
  /** 普通路径调用的业务工具（host alias，按序，不含 jit_* 与 submit_answer） */
  businessCalls: readonly string[];
  describeCalls: number;
  executeCalls: number;
  // JIT 行为（R5 review：拆分代替单一 path = "dsl"）
  /** 是否调用过 jit_describe_tools / jit_execute_program（愿不愿意尝试） */
  jitAttempted: boolean;
  /** 是否至少一次 jit_execute_program 执行成功 */
  jitExecutionSucceeded: boolean;
  /** 最后一次成功程序的语义正确性（无成功执行 → undefined；A 型无 spec → undefined） */
  jitSemanticCorrect: boolean | undefined;
  /** JIT 独立完成：尝试过 JIT 且最后一次程序语义正确且未 fallback（"用对了"的完成级） */
  jitFinishedWithoutFallback: boolean;
  /** 看到 jit_execute_program 结果后仍用普通业务工具补救（round > lastExecuteRound；同一轮并发发出的业务调用不判 fallback） */
  fallbackUsed: boolean;
  /** 第一次 JIT 调用（describe 或 execute）发生在第几轮；未尝试 JIT → undefined */
  offloadDecisionRound?: number;
  /** round < firstJitRound 的业务工具（按序；= 决定 offload 前已做的工作，round-strict） */
  preOffloadBusinessCalls: readonly string[];
  preOffloadBusinessCallCount: number;
  /** round === firstJitRound 的业务工具（按序；= 与第一次 JIT 决策同一轮并发发出，模型尚未看到任何 JIT 结果） */
  sameRoundBusinessCalls: readonly string[];
  sameRoundBusinessCallCount: number;
  /** round > lastExecuteRound 的业务工具（按序；= 模型已看到最后一次 execute 结果后仍用原子工具，真 fallback） */
  postExecuteBusinessCalls: readonly string[];
  postExecuteBusinessCallCount: number;
  /** B 型：round < firstJitRound 已执行掉的、本可 offload 的流水线调用数（preOffload 业务调用 ∩ pipeline 工具）；
   *  任务无 pipeline 定义（A/C）→ undefined */
  preOffloadPipelineCalls?: number;
  /** 及时 offload：决定 offload 时还没执行掉任何本可 offload 的流水线工作，且这次 offload 语义正确。
   *  B 型 = jitSemanticCorrect === true 且 preOffloadPipelineCalls === 0；A/C 无统一 pipeline 定义 → undefined */
  timelyOffload: boolean | undefined;
  /** submit_answer 的 answer 参数（未提交 → undefined） */
  submittedAnswer?: string;
  /** 最终答案匹配 oracle（P0：只认 submit_answer，绝不从 finalText / 程序 result 判定） */
  answerCorrect: boolean;
  /** 严格任务完成：answerCorrect 且（未尝试 JIT 或 JIT 语义正确或有 fallback 补救）。
   *  P0：dslCorrect=false 的 run 必须 fail——错误程序 result 即使包含目标 repo 名也不作数；
   *  且 jitSemanticCorrect === undefined（如 A 型上的尝试）不视为完成，必须 fallback 补救。 */
  taskCompleted: boolean;
  /** 最后一次成功执行 jit_execute_program 的程序记录 */
  lastProgram?: {
    source: string;
    dslCorrect: boolean | undefined;
    compressed?: CompressedPath;
    /** 只统计语义正确程序的压缩操作数（错误 DSL 不计入收益） */
    correctlyCompressedOps?: number;
  };
  /** 失败的 jit_execute_program 尝试（编译失败 / 执行失败的错误文本，截断，最多 5 条） */
  executeErrors?: readonly string[];
  finalText: string;
  error?: string;
}

export interface R5RunDerivationInput {
  arm: R5Arm;
  taskId: R5TaskId;
  rounds: number;
  maxedOut: boolean;
  tokens: R5RunMetrics["tokens"];
  latencyMs: number;
  toolTimeline: readonly R5ToolCallRecord[];
  businessCalls: readonly string[];
  describeCalls: number;
  executeCalls: number;
  jitSemanticCorrect: boolean | undefined;
  executeErrors: readonly string[];
  /** 任务中可确定性 offload 的流水线工具 canonical id（B 型有定义；A/C 无 → undefined）。
   *  用于统计 preOffloadPipelineCalls / timelyOffload。 */
  pipelineToolIds?: readonly string[];
  submittedAnswer?: string;
  finalText: string;
  oracle: readonly (string | RegExp)[];
  error?: string;
}

/** 纯函数：从原始观测推导 R5 run 指标（与模型运行解耦，便于单测回归 P0 语义）。 */
export function deriveR5Metrics(input: R5RunDerivationInput): R5RunMetrics {
  const jitAttempted = input.describeCalls > 0 || input.executeCalls > 0;
  const isJitName = (name: string): boolean =>
    name === DESCRIBE_TOOLS_TOOL.name || name === EXECUTE_PROGRAM_TOOL.name;
  const isSubmit = (name: string): boolean => name === SUBMIT_ANSWER_ID;
  const isBusiness = (name: string): boolean => !isJitName(name) && !isSubmit(name);
  const jitExecutionSucceeded = input.toolTimeline.some(
    (call) => call.name === EXECUTE_PROGRAM_TOOL.name && !call.isError,
  );

  // offload 时机（R5 review 第二轮，round-aware）：按 Agent round 分割业务调用，不再用 timeline
  // 数组位置——同轮并发 describe+业务工具在数组上会落在 JIT 之后而被误判为 fallback。
  // businessCalls 仍按序记录全部业务工具名；三桶分界用 round 与 firstJitRound / lastExecuteRound 比较。
  const firstJitCall = input.toolTimeline.find((call) => isJitName(call.name));
  const firstJitRound = firstJitCall?.round;
  const offloadDecisionRound = firstJitRound;
  const executeCallsInTimeline = input.toolTimeline.filter((call) => call.name === EXECUTE_PROGRAM_TOOL.name);
  const lastExecuteRound =
    executeCallsInTimeline.length > 0 ? executeCallsInTimeline[executeCallsInTimeline.length - 1]!.round : undefined;
  const preOffloadBusinessCalls =
    firstJitRound === undefined
      ? []
      : input.toolTimeline
          .filter((call) => isBusiness(call.name) && call.round < firstJitRound)
          .map((call) => call.name);
  const sameRoundBusinessCalls =
    firstJitRound === undefined
      ? []
      : input.toolTimeline
          .filter((call) => isBusiness(call.name) && call.round === firstJitRound)
          .map((call) => call.name);
  const postExecuteBusinessCalls =
    lastExecuteRound === undefined
      ? []
      : input.toolTimeline
          .filter((call) => isBusiness(call.name) && call.round > lastExecuteRound)
          .map((call) => call.name);
  const fallbackUsed = postExecuteBusinessCalls.length > 0;

  // B 型：round < firstJitRound 已执行掉的、本可 offload 的流水线调用（preOffload 业务调用 ∩ pipeline 工具）。
  // pipelineToolIds 是 canonical id，toolTimeline 记录的是 host alias 名，需转换后比对。
  const pipelineAliases = new Set((input.pipelineToolIds ?? []).map(toolIdAlias));
  const preOffloadPipelineCalls =
    firstJitRound !== undefined && input.pipelineToolIds && input.pipelineToolIds.length > 0
      ? input.toolTimeline.filter(
          (call) => isBusiness(call.name) && call.round < firstJitRound && pipelineAliases.has(call.name),
        ).length
      : undefined;

  // P0 严格输出协议：答案正确性**只认模型显式提交的 submit_answer**。
  // 未提交 → 不判正确（不再退回 finalText）；程序 result 永不参与答案判定。
  const answerCorrect =
    input.submittedAnswer !== undefined && matchesOracle(input.submittedAnswer, input.oracle);

  // P0 严格语义（review 第二版）：
  // - jitSemanticCorrect === undefined（未执行成功 / A 型无 spec 可判）**不视为完成**，
  //   必须 jitSemanticCorrect === true（程序语义正确）或成功 fallback（改用普通工具补救）才算过；
  // - dslCorrect=false 的 run 必须 fail（错误程序 result 即使包含目标 repo 名也不作数）。
  const taskCompleted =
    answerCorrect && (!jitAttempted || input.jitSemanticCorrect === true || fallbackUsed);

  // JIT 独立完成：尝试 + 语义正确 + 无 fallback（"用对了"的完成级，区别于 adoption 的"想用"）
  const jitFinishedWithoutFallback = jitAttempted && input.jitSemanticCorrect === true && !fallbackUsed;

  // 及时 offload：不做全局固定阈值——B 的整个 pipeline 都可 offload，故要求决定时
  // preOffloadPipelineCalls === 0（还没有执行掉任何本可 offload 的工作）且这次 offload 语义正确；
  // A/C 的语义阶段必须执行，无统一 pipeline 定义 → undefined。
  const timelyOffload =
    input.taskId === "B" && preOffloadPipelineCalls !== undefined
      ? jitAttempted && input.jitSemanticCorrect === true && preOffloadPipelineCalls === 0
      : undefined;

  return {
    arm: input.arm,
    taskId: input.taskId,
    rounds: input.rounds,
    maxedOut: input.maxedOut,
    tokens: input.tokens,
    latencyMs: input.latencyMs,
    toolTimeline: input.toolTimeline,
    businessCalls: input.businessCalls,
    describeCalls: input.describeCalls,
    executeCalls: input.executeCalls,
    jitAttempted,
    jitExecutionSucceeded,
    jitSemanticCorrect: input.jitSemanticCorrect,
    jitFinishedWithoutFallback,
    fallbackUsed,
    ...(offloadDecisionRound !== undefined ? { offloadDecisionRound } : {}),
    preOffloadBusinessCalls,
    preOffloadBusinessCallCount: preOffloadBusinessCalls.length,
    sameRoundBusinessCalls,
    sameRoundBusinessCallCount: sameRoundBusinessCalls.length,
    postExecuteBusinessCalls,
    postExecuteBusinessCallCount: postExecuteBusinessCalls.length,
    ...(preOffloadPipelineCalls !== undefined ? { preOffloadPipelineCalls } : {}),
    timelyOffload,
    ...(input.submittedAnswer !== undefined ? { submittedAnswer: input.submittedAnswer } : {}),
    answerCorrect,
    taskCompleted,
    ...(input.executeErrors.length > 0 ? { executeErrors: input.executeErrors } : {}),
    finalText: input.finalText,
    ...(input.error !== undefined ? { error: input.error } : {}),
  };
}

export interface R5RunOptions {
  dslGuidance?: DslGuidanceMode;
  /** reasoning observation：runPiAgent 完成后回调该 run 的全部 reasoningTurns（附加式，不进 R5RunMetrics/report） */
  onReasoningTurns?: (turns: readonly AgentReasoningTurn[]) => void;
}

export async function runR5Run(
  task: R5Task,
  arm: R5Arm,
  runtime: PiRuntime,
  maxRounds = 10,
  options: R5RunOptions = {},
): Promise<R5RunMetrics> {
  const registry = new ToolRegistry<RegisteredTool>([...task.tools, submitAnswerTool]);
  // 双 arm 唯一差异：control 只有 atomic tools（含 submit_answer）；treatment 再挂上 jit_* 元工具。
  // dslGuidance 只影响 treatment 臂（jit_describe_tools 的 manual/bindings 渲染），control 臂无 JIT 不受影响。
  const piTools =
    arm === "control"
      ? registry.all().map((tool) => adaptRegisteredTool(registry, tool))
      : createPiTools(registry, { guidance: options.dslGuidance });

  let describeCalls = 0;
  let executeCalls = 0;
  const businessCalls: string[] = [];
  const executeErrors: string[] = [];
  let submittedAnswer: string | undefined;
  let lastProgramDetails: JitExecuteProgramDetails | undefined;

  const run = await runPiAgent({
    systemPrompt: arm === "control" ? r5ControlSystemPrompt() : r5TreatmentSystemPrompt(),
    tools: piTools,
    prompt: task.prompt,
    runtime,
    maxRounds,
    onToolCall: ({ name, arguments: args }) => {
      if (name === SUBMIT_ANSWER_ID) {
        submittedAnswer = String((args as { answer?: string }).answer ?? "");
        return;
      }
      if (name === DESCRIBE_TOOLS_TOOL.name) {
        describeCalls += 1;
        return;
      }
      if (name === EXECUTE_PROGRAM_TOOL.name) {
        executeCalls += 1;
        return;
      }
      businessCalls.push(name);
    },
    onToolEnd: ({ name, isError, result }) => {
      if (name !== EXECUTE_PROGRAM_TOOL.name) return;
      const details = (result as { details?: JitExecuteProgramDetails } | null)?.details;
      if (details && details.status === "success") {
        lastProgramDetails = details;
        return;
      }
      if (isError) {
        const text =
          (result as { content?: Array<{ text?: string }> } | null)?.content?.map((c) => c.text ?? "").join("") ?? "";
        if (text.trim() && executeErrors.length < 5) executeErrors.push(text.trim().slice(0, 300));
      }
    },
  });

  // reasoning observation：透传该 run 的全部 reasoningTurns（附加式，不进 R5RunMetrics/report）
  options.onReasoningTurns?.(run.reasoningTurns);

  let lastProgram: R5RunMetrics["lastProgram"];
  let jitSemanticCorrect: boolean | undefined;
  if (lastProgramDetails) {
    jitSemanticCorrect = task.spec
      ? checkTaskCorrectness(lastProgramDetails.graph, task.spec).pass
      : undefined;
    const compressed = compressedPath(lastProgramDetails.graph, lastProgramDetails.trace);
    lastProgram = {
      source: lastProgramDetails.source,
      dslCorrect: jitSemanticCorrect,
      compressed,
      // P0 review：correctlyCompressedOps 只统计语义正确程序（错误 DSL 不计入收益）
      ...(jitSemanticCorrect === true ? { correctlyCompressedOps: compressed.atomicOps } : {}),
    };
  }

  const metrics = deriveR5Metrics({
    arm,
    taskId: task.id,
    rounds: run.rounds,
    maxedOut: run.maxedOut,
    tokens: run.tokens,
    latencyMs: run.latencyMs,
    toolTimeline: run.toolCalls.map((call) => ({
      name: call.name,
      isError: call.isError,
      round: call.round,
      arguments: call.arguments,
    })),
    businessCalls,
    describeCalls,
    executeCalls,
    jitSemanticCorrect,
    executeErrors,
    pipelineToolIds: task.pipelineToolIds,
    submittedAnswer,
    finalText: run.finalText,
    oracle: task.oracle,
    ...(run.error !== undefined ? { error: run.error } : {}),
  });
  return {
    ...metrics,
    ...(lastProgram ? { lastProgram } : {}),
  };
}

// ---------------------------------------------------------------------------
// 汇总指标（按 arm × task(A/B/C) 分格报告，不再只看三任务平均）
// ---------------------------------------------------------------------------

export interface R5Aggregate {
  arm: R5Arm;
  taskId: R5TaskId;
  runs: number;
  /** 愿意尝试：jitAttempted 比例（adoption = "想用"） */
  adoptionRate: number;
  /** 尝试后至少一次执行成功的比例 */
  jitExecutionSucceededRate: number;
  /** 最后一次成功程序语义正确的比例 */
  jitSemanticCorrectRate: number;
  /** JIT 独立完成（尝试 + 语义正确 + 无 fallback）比例 */
  jitFinishedWithoutFallbackRate: number;
  /** 真 precision：语义正确 / 尝试过（attempted>0；B/C 有意义；A 上 attempt 已属多余） */
  offloadPrecision: number;
  /** 第一次 JIT 调用的平均轮数（仅统计尝试过 JIT 的 run；无尝试 → 0） */
  avgOffloadDecisionRound: number;
  /** 平均决策前业务调用数（round < firstJitRound） */
  avgPreOffloadBusinessCallCount: number;
  /** 平均与决策同轮业务调用数（round === firstJitRound，并发发出） */
  avgSameRoundBusinessCallCount: number;
  /** 平均看到 execute 结果后的业务调用数（round > lastExecuteRound，真 fallback） */
  avgPostExecuteBusinessCallCount: number;
  /** B 型：平均决策前（round < firstJitRound）已执行掉的流水线调用数（无 pipeline 定义 → undefined） */
  avgPreOffloadPipelineCalls: number | undefined;
  /** 及时 offload 比例（timelyOffload === true / 总 run 数；B 型有定义，A/C → undefined） */
  timelyOffloadRate: number | undefined;
  /** 不该 offload 却尝试：A 上 jitAttempted 比例（B/C 无意义 → undefined，不入 JSON） */
  unnecessaryOffloadRate: number | undefined;
  /** 看到 execute 结果后仍用普通业务工具补救的比例（round > lastExecuteRound） */
  fallbackRate: number;
  /** 跑满轮数比例（独立报告，不再混进路径） */
  maxedOutRate: number;
  /** 严格任务完成率（dslCorrect=false / 无法判定的 JIT run 除非 fallback 补救否则不计完成） */
  taskCompletionRate: number;
  /** 全部成功 JIT 执行的原子操作压缩数均值（含语义错误程序） */
  avgCompressedOps: number;
  /** 只统计语义正确程序的压缩操作数均值（P0：避免错误 DSL 夸大收益） */
  avgCorrectlyCompressedOps: number;
  avgRounds: number;
  avgTokens: number;
}

export function aggregateR5(runs: readonly R5RunMetrics[], arm: R5Arm, taskId: R5TaskId): R5Aggregate {
  const cell = runs.filter((run) => run.arm === arm && run.taskId === taskId);
  const total = cell.length;
  const ratio = (n: number): number => (total > 0 ? n / total : 0);
  const attempted = cell.filter((run) => run.jitAttempted).length;
  const attemptedCorrect = cell.filter((run) => run.jitAttempted && run.jitSemanticCorrect === true).length;
  const compressedOps = cell
    .filter((run) => run.lastProgram?.compressed)
    .map((run) => run.lastProgram!.compressed!.atomicOps);
  const correctlyCompressedOps = cell
    .map((run) => run.lastProgram?.correctlyCompressedOps)
    .filter((value): value is number => value !== undefined);
  const avg = (values: number[]): number => (values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0);
  const decisionRounds = cell
    .map((run) => run.offloadDecisionRound)
    .filter((value): value is number => value !== undefined);
  const preOffloadPipelineValues = cell
    .map((run) => run.preOffloadPipelineCalls)
    .filter((value): value is number => value !== undefined);
  return {
    arm,
    taskId,
    runs: total,
    adoptionRate: ratio(attempted),
    jitExecutionSucceededRate: ratio(cell.filter((run) => run.jitExecutionSucceeded).length),
    jitSemanticCorrectRate: ratio(cell.filter((run) => run.jitSemanticCorrect === true).length),
    jitFinishedWithoutFallbackRate: ratio(cell.filter((run) => run.jitFinishedWithoutFallback).length),
    // P1 review：真 precision = 语义正确 / 尝试过（数学意义与名字一致）
    offloadPrecision: attempted > 0 ? attemptedCorrect / attempted : 0,
    avgOffloadDecisionRound: avg(decisionRounds),
    avgPreOffloadBusinessCallCount: avg(cell.map((run) => run.preOffloadBusinessCallCount)),
    avgSameRoundBusinessCallCount: avg(cell.map((run) => run.sameRoundBusinessCallCount)),
    avgPostExecuteBusinessCallCount: avg(cell.map((run) => run.postExecuteBusinessCallCount)),
    // 无 pipeline 定义（A/C）→ undefined，不入 JSON
    avgPreOffloadPipelineCalls:
      preOffloadPipelineValues.length > 0 ? avg(preOffloadPipelineValues) : undefined,
    timelyOffloadRate: taskId === "B" ? ratio(cell.filter((run) => run.timelyOffload === true).length) : undefined,
    unnecessaryOffloadRate: taskId === "A" ? ratio(attempted) : undefined,
    fallbackRate: ratio(cell.filter((run) => run.fallbackUsed).length),
    maxedOutRate: ratio(cell.filter((run) => run.maxedOut).length),
    taskCompletionRate: ratio(cell.filter((run) => run.taskCompleted).length),
    avgCompressedOps: avg(compressedOps),
    avgCorrectlyCompressedOps: avg(correctlyCompressedOps),
    avgRounds: avg(cell.map((run) => run.rounds)),
    avgTokens: avg(cell.map((run) => run.tokens.total)),
  };
}

/** 报告里的汇总结构：arm → task → aggregate。 */
export type R5Aggregates = Record<R5Arm, Record<R5TaskId, R5Aggregate>>;

export function buildR5Aggregates(runs: readonly R5RunMetrics[]): R5Aggregates {
  return {
    control: {
      A: aggregateR5(runs, "control", "A"),
      B: aggregateR5(runs, "control", "B"),
      C: aggregateR5(runs, "control", "C"),
    },
    treatment: {
      A: aggregateR5(runs, "treatment", "A"),
      B: aggregateR5(runs, "treatment", "B"),
      C: aggregateR5(runs, "treatment", "C"),
    },
  };
}

// ---------------------------------------------------------------------------
// 结果落盘：logs/experiments/r5-offloading-<ts>/report.json（与 r4e 等实验约定一致，
// logs/ 纳入版本控制——实验可复现性要求保留原始 report.json）
// ---------------------------------------------------------------------------

export interface R5ReportConfig {
  arm: R5Arm | "both";
  task: "A" | "B" | "C" | "all";
  samples: number;
  rounds: number;
  /** C 型 candidate 数（P2 C-scaling：4/10/20/40；undefined = 默认 8） */
  candidates?: number;
  /** Z/P/F ablation：DSL 参考渲染模式（report 记录用；可选，缺省不写） */
  dslGuidance?: DslGuidanceMode;
}

/**
 * 把一次 R5 实验的结果完整写入 report.json：
 * 配置 + 任务元数据（prompt / oracle）+ 每个 run 的全部指标 + arm×task 分格汇总。
 * 返回 report.json 的绝对路径。
 */
export function writeR5Report(
  outDir: string,
  config: R5ReportConfig,
  tasks: readonly R5Task[],
  runs: readonly R5RunMetrics[],
  aggregates: R5Aggregates,
): string {
  fs.mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, "report.json");
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        mode: "r5-autonomous-offloading",
        config,
        model: "deepseek-chat",
        timestamp: new Date().toISOString(),
        tasks: tasks.map((task) => ({
          id: task.id,
          name: task.name,
          prompt: task.prompt,
          oracle: task.oracle.map(String),
        })),
        aggregates,
        runs,
      },
      null,
      2,
    )}\n`,
  );
  return reportPath;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface R5CliFlags {
  arm: R5Arm | "both";
  task: "A" | "B" | "C" | "all";
  samples: number;
  rounds: number;
  candidates?: number;
  /** Z/P/F ablation：DSL 参考的渲染模式（默认 primitive = production default） */
  dslGuidance: DslGuidanceMode;
}

export function parseFlags(argv: readonly string[]): R5CliFlags {
  const flags: R5CliFlags = { arm: "both", task: "all", samples: 1, rounds: 10, dslGuidance: "primitive" };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "arm" && (value === "control" || value === "treatment" || value === "both")) flags.arm = value;
    if (key === "task" && (value === "A" || value === "B" || value === "C" || value === "all")) flags.task = value;
    if (key === "samples") flags.samples = Math.max(1, Number(value) || 1);
    if (key === "rounds") flags.rounds = Math.max(2, Number(value) || 10);
    if (key === "candidates") flags.candidates = Math.max(2, Number(value) || 8);
    if (key === "dsl-guidance") {
      if (value === "primitive" || value === "patterns" || value === "full-example") flags.dslGuidance = value;
      else throw new Error(`--dsl-guidance 必须是 primitive|patterns|full-example（当前：${value}）`);
    }
  }
  return flags;
}

const ARM_LABEL: Record<R5Arm, string> = {
  control: "Control（普通 Agent）",
  treatment: "Treatment（+ JIT）",
};

async function main(): Promise<number> {
  loadEnv(REPO_ROOT);
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error("[FAIL] 缺少 DEEPSEEK_API_KEY（请在 .env 中配置）");
    return 1;
  }

  const { arm, task, samples, rounds, candidates, dslGuidance } = parseFlags(process.argv.slice(2));
  const tasks = R5_TASKS.filter((item) => task === "all" || item.id === task).map((item) =>
    candidates !== undefined && item.id === "C" ? createR5CTask(candidates) : item,
  );
  const arms: R5Arm[] = arm === "both" ? ["control", "treatment"] : [arm];
  const runtime = createDeepSeekPiRuntime();

  const runs: R5RunMetrics[] = [];
  for (const currentArm of arms) {
    for (const currentTask of tasks) {
      for (let i = 1; i <= samples; i += 1) {
        console.log(`\n===== [${currentArm}/${currentTask.id}] ${currentTask.name}（sample ${i}/${samples}）=====`);
        const run = await runR5Run(currentTask, currentArm, runtime, rounds, { dslGuidance });
        runs.push(run);
        console.log(
          `→ rounds=${run.rounds} maxedOut=${run.maxedOut} tokens=${run.tokens.total} latency=${run.latencyMs}ms ` +
            `answer=${run.answerCorrect ? "✓" : "✗"} completed=${run.taskCompleted ? "✓" : "✗"}`,
        );
        console.log(
          `  jitAttempted=${run.jitAttempted} execSucceeded=${run.jitExecutionSucceeded} ` +
            `semantic=${run.jitSemanticCorrect === undefined ? "n/a" : run.jitSemanticCorrect} ` +
            `jitFinishedWithoutFallback=${run.jitFinishedWithoutFallback} fallback=${run.fallbackUsed} ` +
            `describe=${run.describeCalls} execute=${run.executeCalls} business=[${run.businessCalls.join(", ") || "无"}]`,
        );
        if (run.offloadDecisionRound !== undefined) {
          console.log(
            `  offloadDecisionRound=${run.offloadDecisionRound} ` +
              `pre=${run.preOffloadBusinessCallCount} same=${run.sameRoundBusinessCallCount} postExec=${run.postExecuteBusinessCallCount}` +
              (run.preOffloadPipelineCalls !== undefined ? ` preOffloadPipeline=${run.preOffloadPipelineCalls}` : "") +
              ` timely=${run.timelyOffload === undefined ? "n/a" : run.timelyOffload}`,
          );
        }
        if (run.submittedAnswer !== undefined) console.log(`  submit_answer：${run.submittedAnswer.slice(0, 300)}`);
        if (run.lastProgram) {
          console.log(`  DSL 正确：${run.lastProgram.dslCorrect === undefined ? "n/a" : run.lastProgram.dslCorrect}`);
          console.log(`  程序源码：\n${run.lastProgram.source.replace(/^/gm, "    ")}`);
          if (run.lastProgram.compressed) {
            const c = run.lastProgram.compressed;
            console.log(
              `  压缩路径：atomicOps=${c.atomicOps}（tool=${c.toolNodes} map=${c.mapNodes} fanout=${c.fanoutSum} ` +
                `compute=${c.computeNodes} merge=${c.mergeNodes} concat=${c.concatNodes} return=${c.returnNodes}）` +
                (run.lastProgram.correctlyCompressedOps !== undefined
                  ? ` 正确压缩=${run.lastProgram.correctlyCompressedOps}`
                  : "（语义错误，不计入正确压缩收益）"),
            );
          }
        }
        for (const errorText of run.executeErrors ?? []) {
          console.log(`  [execute 失败] ${errorText.replace(/\n/g, " ").slice(0, 200)}`);
        }
        if (run.finalText.trim()) console.log(`  最终文本：${run.finalText.slice(0, 300)}`);
      }
    }
  }

  console.log("\n\n===== R5 汇总（arm × task 分格）=====");
  const aggregates = buildR5Aggregates(runs);
  const taskCells: R5TaskId[] = ["A", "B", "C"];
  for (const currentArm of arms) {
    console.log(`\n${ARM_LABEL[currentArm]}`);
    for (const taskId of taskCells) {
      const agg = aggregates[currentArm][taskId];
      const unnecessary = agg.unnecessaryOffloadRate === undefined ? "n/a" : `${(agg.unnecessaryOffloadRate * 100).toFixed(0)}%`;
      const timely = agg.timelyOffloadRate === undefined ? "n/a" : `${(agg.timelyOffloadRate * 100).toFixed(0)}%`;
      const avgPipeline = agg.avgPreOffloadPipelineCalls === undefined ? "n/a" : agg.avgPreOffloadPipelineCalls.toFixed(1);
      console.log(
        `  [${taskId}] runs=${agg.runs} ` +
          `adoption=${(agg.adoptionRate * 100).toFixed(0)}% ` +
          `execSucceeded=${(agg.jitExecutionSucceededRate * 100).toFixed(0)}% ` +
          `semanticCorrect=${(agg.jitSemanticCorrectRate * 100).toFixed(0)}% ` +
          `jitFinishedWithoutFallback=${(agg.jitFinishedWithoutFallbackRate * 100).toFixed(0)}% ` +
          `offloadPrecision=${(agg.offloadPrecision * 100).toFixed(0)}% ` +
          `unnecessary=${unnecessary} ` +
          `fallback=${(agg.fallbackRate * 100).toFixed(0)}% ` +
          `maxedOut=${(agg.maxedOutRate * 100).toFixed(0)}% ` +
          `taskCompleted=${(agg.taskCompletionRate * 100).toFixed(0)}% ` +
          `compressed=${agg.avgCompressedOps.toFixed(1)} ` +
          `correctCompressed=${agg.avgCorrectlyCompressedOps.toFixed(1)} ` +
          `rounds=${agg.avgRounds.toFixed(1)} tokens=${Math.round(agg.avgTokens)} ` +
          `offloadRound=${agg.avgOffloadDecisionRound.toFixed(1)} ` +
          `pre=${agg.avgPreOffloadBusinessCallCount.toFixed(1)} same=${agg.avgSameRoundBusinessCallCount.toFixed(1)} postExec=${agg.avgPostExecuteBusinessCallCount.toFixed(1)} ` +
          `preOffloadPipeline=${avgPipeline} timely=${timely}`,
      );
    }
  }

  const outDir = path.join(
    REPO_ROOT,
    "logs",
    "experiments",
    `r5-offloading-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  const reportPath = writeR5Report(
    outDir,
    { arm, task, samples, rounds, dslGuidance, ...(candidates !== undefined ? { candidates } : {}) },
    tasks,
    runs,
    aggregates,
  );
  console.log(`\n报告已写入: ${reportPath}`);
  return 0;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error("[FAIL]", (error as Error).message);
      process.exit(1);
    });
}
