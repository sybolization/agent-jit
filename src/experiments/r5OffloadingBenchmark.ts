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

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

import { createDeepSeekPiRuntime, type PiRuntime } from "../llm/gateway.js";
import { adaptRegisteredTool, createPiTools } from "../integrations/pi/toolAdapter.js";
import { renderDslReferenceWithSource, type DslGuidanceMode } from "../integrations/pi/dslReference.js";
import type { JitExecuteProgramDetails } from "../integrations/pi/jit.js";
import type { ExecutionGraph } from "../compiler/ir.js";
import type { TraceEntry } from "../runtime/trace.js";
import { defineTool, type RegisteredTool } from "../tools/definition.js";
import { DESCRIBE_TOOLS_TOOL, EXECUTE_PROGRAM_TOOL } from "../tools/jitTools.js";
import { renderCompactManifest } from "../tools/compactContractRenderer.js";
import { toolIdAlias, ToolRegistry } from "../tools/registry.js";
import { checkTaskCorrectness } from "./taskSpec.js";
import { runPiAgent, type AgentReasoningTurn, type AgentTokenRound } from "./agentRunner.js";
import { createR5CTask, R5_TASKS, type R5Task, type R5TaskId } from "./r5Tasks.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

/** R6 contract acquisition 模式（三臂）：eager = 现状 baseline（先 describe 拿契约再 execute）；compile-only = 无前置 describe、不挂 describe 工具，直接写程序，编译诊断兜底；manifest = compile-only + 紧凑 output manifest。 */
export type R6ContractMode = "eager" | "compile-only" | "manifest";

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
 * Offload 边界策略（--boundary-policy 开启时追加到 treatment 常驻系统提示词）。
 * 只加两条规则，不写 JIT 教程：
 * 1. offload 的判断依据是"后续决策规则是否已确定"，不是"运行时数据是否已获得"；
 * 2. 决定 offload 后，不在同一个 assistant turn 里并行调用该片段涉及的普通业务工具。
 */
export const BOUNDARY_POLICY_RULES: readonly string[] = [
  "判断是否把一段后续工作交给 JIT：依据是这段工作的后续决策规则（过滤阈值、排序键、截取数量等）是否已经由任务确定——只要决策规则已确定，即使数据还没拿到，也可以立即把整段工作一次性程序化；不要在确定可程序化之后，还先用普通工具把数据逐个做一遍。",
  "一旦决定把某个确定性片段 offload 给 JIT，就不要在同一个 assistant turn 里再并行调用该片段涉及的普通业务工具（包括与 describe / execute 同一轮发出的调用）——那会造成重复工作；先 describe + execute，看到 JIT 结果后再判断是否需要补救。",
];

/**
 * treatment 臂：普通工具 + Agent JIT；是否 offload 由模型自己决定。
 *
 * 常驻 prompt **极简**（R5 review）：不内嵌 DSL 语法 / 示例 / 使用规则——DSL manual
 * 改为按需加载：jit_describe_tools 第一次调用会随契约返回极简语法参考（见
 * src/integrations/pi/dslReference.ts 的 renderDslReference(guidance)（--dsl-guidance 可选 primitive/patterns/full-example，默认 primitive））。
 * 这样 A 型这种完全不用 JIT 的任务基本不承担 DSL context 成本（控制 context tax 的设计意图）。
 */
export function r5TreatmentSystemPrompt(options?: {
  boundaryPolicy?: boolean;
  contractMode?: R6ContractMode;
  manifest?: string;
}): string {
  const contractMode = options?.contractMode ?? "eager";
  // 三臂的 JIT 说明行：
  // - eager（现状）：先 describe 拿契约，再 execute；
  // - compile-only / manifest：直接 execute，编译失败按结构化诊断修正（不提供 describe 工具）。
  const jitLine =
    contractMode === "eager"
      ? `- Agent JIT：将已经确定的多步工具操作编译执行——需要时先用 ${DESCRIBE_TOOLS_TOOL.name} 获取编程契约（返回 DSL 语法极简参考 + 你要编排工具的契约），再用 ${EXECUTE_PROGRAM_TOOL.name} 提交程序。`
      : `- Agent JIT：将已经确定的多步工具操作编译执行——直接调用 ${EXECUTE_PROGRAM_TOOL.name} 提交程序；编译失败会返回结构化诊断（含可用字段/参数名），按诊断修正后重试即可。`;
  return [
    "你是一个自主 Agent，需要完成用户交给的任务。你有两类工具：",
    "- 普通业务工具：直接调用（工具名与参数见工具定义），适合单次查询/操作。",
    jitLine,
    "",
    "是否使用 JIT 由你决定：单个查询用普通工具即可；一段后续工作可以确定性程序化（对列表每个元素做同样处理、过滤/排序/合并/取前 N 等）时再考虑 JIT。",
    `完成所有工具调用后，调用 ${SUBMIT_ANSWER_ID}(answer="...") 提交最终答案（最终答案的唯一提交通道，不要只写在普通文本里）。`,
    // 无前置 describe 的臂（compile-only / manifest）：DSL 语言语义（无任何工具契约）常驻提示词，
    // 先加一行澄清：工具参数名/类型以工具定义为准（模型可见），输出字段在编译前未知——交给编译诊断指出。
    // 核心参考用 definitions 变体（Tool calls 段不再提 jit_describe_tools——该工具未注册，避免模型误用）。
    ...(contractMode === "compile-only" || contractMode === "manifest"
      ? [
          "",
          "工具的参数名与类型以你的工具定义为准（你已可见）；输出字段在编译前未知——先写程序提交，编译诊断会指出不存在的字段并列出可用字段。",
          renderDslReferenceWithSource("primitive", { toolContractSource: "definitions" }),
        ]
      : []),
    // manifest：再追加紧凑 output manifest（只含工具输出形状）
    ...(contractMode === "manifest" && options?.manifest !== undefined && options.manifest.length > 0
      ? ["", "## Output manifest", options.manifest]
      : []),
    // 边界策略段最后追加（eager 下为空数组，顺序与现状一致 → 输出逐字节不变）
    ...(options?.boundaryPolicy === true
      ? ["", "## Offload 边界策略", ...BOUNDARY_POLICY_RULES.map((rule, index) => `${index + 1}. ${rule}`)]
      : []),
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
  /** 每轮 token usage（round-level 观测；新 run 由 runPiAgent 透传；老报告无此字段） */
  tokenRounds?: readonly AgentTokenRound[];
  latencyMs: number;
  /** 完整工具时间线（业务 / jit_describe_tools / jit_execute_program / submit_answer，按序） */
  toolTimeline: readonly R5ToolCallRecord[];
  /** 普通路径调用的业务工具（host alias，按序，不含 jit_* 与 submit_answer） */
  businessCalls: readonly string[];
  describeCalls: number;
  executeCalls: number;
  /** R6.1：jit_execute_program 调用次数（= executeCalls，compile-only 的编译尝试数；deriveR5Metrics 恒返回，声明为可选以兼容既有字面量构造的测试） */
  compileAttempts?: number;
  /** R6.1：首次 jit_execute_program 是否编译通过（无 execute 调用 → undefined） */
  firstPassCompileSuccess?: boolean;
  /** R6.1：首次失败到首次成功的修复轮数（首轮即成功 → 0；从未成功 → 总轮数 − 首次失败轮；无 execute → undefined） */
  repairRounds?: number;
  /** R6.1：是否在首次 execute 失败后才调用 jit_describe_tools（= 编译失败后的 describe 兜底；无 describe 或从未失败 → false；compile-only/manifest 臂不挂 describe 工具，恒 false；deriveR5Metrics 恒返回，声明为可选以兼容既有字面量构造的测试） */
  describeFallbackUsed?: boolean;
  /** R6.1：是否存在"先 describe 后 execute"（describe 调用轮 < 首次 execute 轮；无 describe 调用 → 省略该字段） */
  preDescribeUsed?: boolean;
  /** R6.1：repair 区间（首次失败轮 .. 首次成功轮/末尾）轮次的 tokenRounds total 之和（无 tokenRounds → undefined） */
  repairTokens?: number;
  /** R6.1：该 run 的 contract acquisition 模式（eager / compile-only / manifest；runR5Run 透传；R6 三臂分臂聚合的事实源） */
  contractMode?: R6ContractMode;
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
  /** B 型：round === firstJitRound 的业务调用 ∩ pipeline 工具（= 与 JIT 决策同轮并发发出的可 offload 调用，speculative；无 pipeline 定义 → undefined） */
  sameRoundPipelineCalls?: readonly string[];
  sameRoundPipelineCallCount?: number;
  /** B 型：JIT 真正开始前（决策轮之前 + 同轮）执行掉的、本可 offload 的流水线调用数 = preOffloadPipelineCalls + sameRoundPipelineCallCount */
  preExecutePipelineCalls?: number;
  /** B 型：JIT 意图出现得早 = jitAttempted 且 preOffloadPipelineCalls === 0（纯决策时间维度，不含语义与同轮；无 pipeline 定义 → undefined） */
  earlyOffloadDecision?: boolean;
  /** B 型：JIT source 内重复执行的已完成 pipeline 工具数（source 中出现 且 host 在 firstJitRound 含同轮前已调用；无成功程序/无 pipeline → undefined） */
  duplicatedPipelineCalls?: number;
  /** @deprecated 语义与 earlyOffloadDecision 重叠但额外绑定语义正确性，逐步弃用（保留旧定义）。
   *  及时 offload：决定 offload 时还没执行掉任何本可 offload 的流水线工作，且这次 offload 语义正确。
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
  tokenRounds?: readonly AgentTokenRound[];
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
  /** 最后一次成功执行 jit_execute_program 的程序源码（duplicatedPipelineCalls 判重用；无成功执行 → undefined） */
  lastProgramSource?: string;
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

  // R6.1 新指标：compile-only / manifest 臂的恢复成本
  // （首次编译是否直接通过、失败→成功的修复轮数、describe 兜底频率、repair 区间的 token 成本）
  const firstExecuteCall = executeCallsInTimeline[0];
  const firstPassCompileSuccess = firstExecuteCall === undefined ? undefined : !firstExecuteCall.isError;
  const firstFailedExecuteRound = executeCallsInTimeline.find((call) => call.isError)?.round;
  const firstSuccessExecuteRound = executeCallsInTimeline.find((call) => !call.isError)?.round;
  // R6.1：describe 兜底语义精化——describeFallbackUsed = "首次 execute 失败之后才调 describe"（fallback 指示），
  // 不再是"是否调过 describe"（eager 臂的正常先 describe 流程不再被误判为 fallback）；
  // preDescribeUsed = "describe 发生在首次 execute 之前"（先拿契约再写程序；无 describe 调用 → 省略该字段）。
  const describeAfterFailedExecute = input.toolTimeline.some(
    (call) =>
      call.name === DESCRIBE_TOOLS_TOOL.name && firstFailedExecuteRound !== undefined && call.round > firstFailedExecuteRound,
  );
  const preDescribeUsed = input.toolTimeline.some(
    (call) => call.name === DESCRIBE_TOOLS_TOOL.name && firstExecuteCall !== undefined && call.round < firstExecuteCall.round,
  )
    ? true
    : input.describeCalls > 0
      ? false
      : undefined;
  let repairRounds: number | undefined;
  if (firstExecuteCall === undefined) repairRounds = undefined;
  else if (firstPassCompileSuccess === true) repairRounds = 0;
  else if (firstSuccessExecuteRound !== undefined && firstFailedExecuteRound !== undefined)
    repairRounds = firstSuccessExecuteRound - firstFailedExecuteRound;
  else if (firstFailedExecuteRound !== undefined) repairRounds = input.rounds - firstFailedExecuteRound;
  let repairTokens: number | undefined;
  if (input.tokenRounds !== undefined && firstFailedExecuteRound !== undefined) {
    const endRound = firstSuccessExecuteRound ?? input.rounds;
    repairTokens = input.tokenRounds
      .filter((item) => item.round >= firstFailedExecuteRound && item.round <= endRound)
      .reduce((sum, item) => sum + item.total, 0);
  }
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

  // 同轮 speculative：与第一次 JIT 决策同一轮并发发出的、本可 offload 的流水线调用
  // （模型尚未看到任何 JIT 结果；B 型）。
  const sameRoundPipelineCalls =
    firstJitRound !== undefined && input.pipelineToolIds && input.pipelineToolIds.length > 0
      ? input.toolTimeline
          .filter((call) => isBusiness(call.name) && call.round === firstJitRound && pipelineAliases.has(call.name))
          .map((call) => call.name)
      : undefined;
  // JIT 真正开始前（决策前 + 同轮）的重复工作量：真 clean 必须 preExecutePipelineCalls === 0
  const preExecutePipelineCalls =
    preOffloadPipelineCalls !== undefined && sameRoundPipelineCalls !== undefined
      ? preOffloadPipelineCalls + sameRoundPipelineCalls.length
      : undefined;
  // 决策时间维度（与语义解耦）：JIT 意图出现得早 = 决策轮之前没有执行掉本可 offload 的流水线工作
  const earlyOffloadDecision =
    input.taskId === "B" && preOffloadPipelineCalls !== undefined
      ? jitAttempted && preOffloadPipelineCalls === 0
      : undefined;
  // 重复工作：JIT source 里重新执行的、host 在第一次 JIT 调用（含同轮）前已完成的 pipeline 工具
  const duplicatedPipelineCalls =
    input.taskId === "B" &&
    firstJitRound !== undefined &&
    input.pipelineToolIds &&
    input.pipelineToolIds.length > 0 &&
    input.lastProgramSource
      ? input.pipelineToolIds.filter(
          (canonical) =>
            input.lastProgramSource!.includes(canonical) &&
            input.toolTimeline.some(
              (call) => isBusiness(call.name) && call.round <= firstJitRound && toolIdAlias(canonical) === call.name,
            ),
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
    ...(input.tokenRounds !== undefined ? { tokenRounds: input.tokenRounds } : {}),
    latencyMs: input.latencyMs,
    toolTimeline: input.toolTimeline,
    businessCalls: input.businessCalls,
    describeCalls: input.describeCalls,
    executeCalls: input.executeCalls,
    compileAttempts: input.executeCalls,
    ...(firstPassCompileSuccess !== undefined ? { firstPassCompileSuccess } : {}),
    ...(repairRounds !== undefined ? { repairRounds } : {}),
    describeFallbackUsed: describeAfterFailedExecute,
    ...(preDescribeUsed !== undefined ? { preDescribeUsed } : {}),
    ...(repairTokens !== undefined ? { repairTokens } : {}),
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
    ...(sameRoundPipelineCalls !== undefined
      ? { sameRoundPipelineCalls, sameRoundPipelineCallCount: sameRoundPipelineCalls.length }
      : {}),
    ...(preExecutePipelineCalls !== undefined ? { preExecutePipelineCalls } : {}),
    ...(earlyOffloadDecision !== undefined ? { earlyOffloadDecision } : {}),
    ...(duplicatedPipelineCalls !== undefined ? { duplicatedPipelineCalls } : {}),
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
  /** stop-after-submit：submit_answer 执行后 agent 直接结束（不再生成最终文本轮）；默认 false = 旧行为 */
  stopAfterSubmit?: boolean;
  /** boundary-policy：treatment 常驻提示词追加 Offload 边界策略（两条规则）；默认 false = 旧极简提示词 */
  boundaryPolicy?: boolean;
  /** R6.1 contract acquisition 模式：缺省 eager = 现状（先 describe 拿契约再 execute）；compile-only / manifest = 直接 execute + 结构化诊断兜底（describeTools:false，不挂 describe 工具） */
  contractMode?: R6ContractMode;
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
  const piTools = (arm === "control"
    ? registry.all().map((tool) => adaptRegisteredTool(registry, tool))
    : createPiTools(registry, {
        guidance: options.dslGuidance,
        ...(options.contractMode === "compile-only" || options.contractMode === "manifest"
          ? { describeTools: false }
          : {}),
      })
  ).map((tool) => (tool.name === SUBMIT_ANSWER_ID && options.stopAfterSubmit ? createR5SubmitTool(true) : tool));

  let describeCalls = 0;
  let executeCalls = 0;
  const businessCalls: string[] = [];
  const executeErrors: string[] = [];
  let submittedAnswer: string | undefined;
  let lastProgramDetails: JitExecuteProgramDetails | undefined;

  const run = await runPiAgent({
    systemPrompt:
      arm === "control"
        ? r5ControlSystemPrompt()
        : r5TreatmentSystemPrompt({
            ...(options.boundaryPolicy ? { boundaryPolicy: true } : {}),
            ...(options.contractMode !== undefined && options.contractMode !== "eager"
              ? { contractMode: options.contractMode }
              : {}),
            ...(options.contractMode === "manifest" ? { manifest: renderCompactManifest(registry) } : {}),
          }),
    tools: piTools,
    prompt: task.prompt,
    runtime,
    maxRounds,
    ...(options.stopAfterSubmit ? { terminatingToolNames: [SUBMIT_ANSWER_ID] } : {}),
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
    tokenRounds: run.tokenRounds,
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
    lastProgramSource: lastProgramDetails?.source,
    submittedAnswer,
    finalText: run.finalText,
    oracle: task.oracle,
    ...(run.error !== undefined ? { error: run.error } : {}),
  });
  return {
    ...metrics,
    ...(options.contractMode !== undefined ? { contractMode: options.contractMode } : {}),
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
  /** B 型：平均与决策同轮发出的 pipeline 调用数（无 pipeline 定义 → undefined） */
  avgSameRoundPipelineCalls: number | undefined;
  /** B 型：平均 JIT 开始前（决策前 + 同轮）执行掉的 pipeline 调用数（无 pipeline 定义 → undefined） */
  avgPreExecutePipelineCalls: number | undefined;
  /** B 型：earlyOffloadDecision === true 比例（无 pipeline 定义 → undefined） */
  earlyOffloadDecisionRate: number | undefined;
  /** @deprecated 与 earlyOffloadDecisionRate 重叠，逐步弃用。
   *  及时 offload 比例（timelyOffload === true / 总 run 数；B 型有定义，A/C → undefined） */
  timelyOffloadRate: number | undefined;
  /** 不该 offload 却尝试：A 上 jitAttempted 比例（B/C 无意义 → undefined，不入 JSON） */
  unnecessaryOffloadRate: number | undefined;
  /** cleanOffload 组占比（classifyR5JitGroup 落入 cleanOffload 的 run 数 / 格内总数；Primary Metric） */
  cleanOffloadRate: number;
  /** earlyDirtyOffload 组占比 */
  earlyDirtyOffloadRate: number;
  /** lateOffload 组占比 */
  lateOffloadRate: number;
  /** noJit 组占比（= 1 - adoptionRate，单独列出便于四组对齐） */
  noJitRate: number;
  /** B 型：平均 JIT source 内重复执行的 pipeline 工具数（duplicatedPipelineCalls 有定义值的均值；无定义 → undefined） */
  avgDuplicatedPipelineCalls: number | undefined;
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
  /** 平均 uncached input token（与 avgTokens 并列，回答"JIT 省的是 cache traffic 还是 output"） */
  avgUncachedInputTokens: number;
  /** 平均 cache read token */
  avgCacheReadTokens: number;
  /** 平均 output token */
  avgOutputTokens: number;
  /** R6.1：首次 execute 编译通过比例（firstPassCompileSuccess === true / 格内总数，含未尝试 compile 的 run 作分母） */
  firstPassCompileRateOverall: number;
  /** R6.1：首次 execute 编译通过比例（仅统计尝试过 compile 的 run：firstPassCompileSuccess === true / executeCalls > 0；无尝试 → 0） */
  firstPassCompileRateAmongAttempts: number;
  /** R6.1：最终至少一次 execute 成功的比例（= jitExecutionSucceededRate，语义别名） */
  eventualCompileRate: number;
  /** R6.1：平均修复轮数（repairRounds 有定义值的均值） */
  avgRepairRounds: number;
  /** R6.1：describeFallbackUsed === true 比例（compile-only/manifest 臂不挂 describe 工具，恒 0；eager 臂指"首次 execute 失败后兜底 describe"的频率） */
  describeFallbackRate: number;
  /** R6.1：preDescribeUsed === true 比例（先 describe 后 execute 的 run 占比） */
  preDescribeUsedRate: number;
  /** R6.1：平均 repairTokens（有定义值的均值；无 → undefined） */
  avgRepairTokens: number | undefined;
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
  const sameRoundPipelineValues = cell
    .map((run) => run.sameRoundPipelineCallCount)
    .filter((value): value is number => value !== undefined);
  const preExecutePipelineValues = cell
    .map((run) => run.preExecutePipelineCalls)
    .filter((value): value is number => value !== undefined);
  const groupCounts: Record<R5JitGroupId, number> = { cleanOffload: 0, earlyDirtyOffload: 0, lateOffload: 0, noJit: 0 };
  for (const run of cell) groupCounts[classifyR5JitGroup(run)] += 1;
  const duplicatedPipelineValues = cell
    .map((run) => run.duplicatedPipelineCalls)
    .filter((value): value is number => value !== undefined);
  // R6.1：compile-only / manifest 臂的汇总（repair 指标只统计有定义值的 run）
  const repairRoundsValues = cell
    .map((run) => run.repairRounds)
    .filter((value): value is number => value !== undefined);
  const repairTokenValues = cell
    .map((run) => run.repairTokens)
    .filter((value): value is number => value !== undefined);
  // R6.1：尝试过 compile 的 run 数（firstPassCompileRateAmongAttempts 的分母；executeCalls > 0）
  const compileAttemptRuns = cell.filter((run) => run.executeCalls > 0).length;
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
    avgSameRoundPipelineCalls: sameRoundPipelineValues.length > 0 ? avg(sameRoundPipelineValues) : undefined,
    avgPreExecutePipelineCalls: preExecutePipelineValues.length > 0 ? avg(preExecutePipelineValues) : undefined,
    earlyOffloadDecisionRate: taskId === "B" ? ratio(cell.filter((run) => run.earlyOffloadDecision === true).length) : undefined,
    timelyOffloadRate: taskId === "B" ? ratio(cell.filter((run) => run.timelyOffload === true).length) : undefined,
    unnecessaryOffloadRate: taskId === "A" ? ratio(attempted) : undefined,
    cleanOffloadRate: ratio(groupCounts.cleanOffload),
    earlyDirtyOffloadRate: ratio(groupCounts.earlyDirtyOffload),
    lateOffloadRate: ratio(groupCounts.lateOffload),
    noJitRate: ratio(groupCounts.noJit),
    avgDuplicatedPipelineCalls: duplicatedPipelineValues.length > 0 ? avg(duplicatedPipelineValues) : undefined,
    fallbackRate: ratio(cell.filter((run) => run.fallbackUsed).length),
    maxedOutRate: ratio(cell.filter((run) => run.maxedOut).length),
    taskCompletionRate: ratio(cell.filter((run) => run.taskCompleted).length),
    avgCompressedOps: avg(compressedOps),
    avgCorrectlyCompressedOps: avg(correctlyCompressedOps),
    avgRounds: avg(cell.map((run) => run.rounds)),
    avgTokens: avg(cell.map((run) => run.tokens.total)),
    avgUncachedInputTokens: avg(cell.map((run) => run.tokens.input)),
    avgCacheReadTokens: avg(cell.map((run) => run.tokens.cacheRead)),
    avgOutputTokens: avg(cell.map((run) => run.tokens.output)),
    // R6.1：compile-only / manifest 臂的汇总（eventualCompileRate = jitExecutionSucceededRate 语义别名）
    firstPassCompileRateOverall: ratio(cell.filter((run) => run.firstPassCompileSuccess === true).length),
    firstPassCompileRateAmongAttempts: compileAttemptRuns > 0
      ? cell.filter((run) => run.firstPassCompileSuccess === true).length / compileAttemptRuns
      : 0,
    eventualCompileRate: ratio(cell.filter((run) => run.jitExecutionSucceeded).length),
    avgRepairRounds: avg(repairRoundsValues),
    describeFallbackRate: ratio(cell.filter((run) => run.describeFallbackUsed).length),
    preDescribeUsedRate: ratio(cell.filter((run) => run.preDescribeUsed === true).length),
    avgRepairTokens: repairTokenValues.length > 0 ? avg(repairTokenValues) : undefined,
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
// clean / late JIT 分组：token 花在干净 offload 还是 late offload / 没 offload
// ---------------------------------------------------------------------------

export type R5JitGroupId = "cleanOffload" | "earlyDirtyOffload" | "lateOffload" | "noJit";

export interface R5JitGroup {
  group: R5JitGroupId;
  runs: number;
  avgTokens: number;
  avgUncachedInput: number;
  avgCacheRead: number;
  avgOutput: number;
  avgRounds: number;
}

/**
 * 按 offload 质量分组（不重不漏，每个 run 恰属一组）：
 * - noJit：未尝试 JIT；
 * - lateOffload：决策晚（earlyOffloadDecision === false，即决策轮之前已执行掉本可 offload 的流水线工作）；
 * - cleanOffload：严格干净 = jitFinishedWithoutFallback 且 preExecutePipelineCalls === 0
 *   （决策前 + 同轮都没有执行掉本可 offload 的流水线工作；A/C 无 pipeline 定义时保持旧 clean 语义）；
 * - earlyDirtyOffload：决策早但执行边界不干净（同轮 speculative pipeline / 语义错 / fallback）。
 * token 分项统计基于 run 级 tokens（老报告无 tokenRounds 也可用）。
 */
/** 单个 run 的 offload 分组判定（不重不漏；buildR5JitGroups 与 r5TokenProfile 共用）。 */
export function classifyR5JitGroup(run: R5RunMetrics): R5JitGroupId {
  if (!run.jitAttempted) return "noJit";
  if (run.earlyOffloadDecision === false) return "lateOffload";
  if (
    run.jitFinishedWithoutFallback &&
    (run.preExecutePipelineCalls === undefined || run.preExecutePipelineCalls === 0)
  ) {
    return "cleanOffload";
  }
  return "earlyDirtyOffload";
}

export function buildR5JitGroups(
  runs: readonly R5RunMetrics[],
  arm: R5Arm,
  taskId: R5TaskId,
): R5JitGroup[] {
  const cell = runs.filter((run) => run.arm === arm && run.taskId === taskId);
  const buckets: Record<R5JitGroupId, R5RunMetrics[]> = {
    cleanOffload: [],
    earlyDirtyOffload: [],
    lateOffload: [],
    noJit: [],
  };
  for (const run of cell) {
    buckets[classifyR5JitGroup(run)].push(run);
  }
  const avg = (bucket: readonly R5RunMetrics[], pick: (run: R5RunMetrics) => number): number =>
    bucket.length > 0 ? bucket.reduce((sum, run) => sum + pick(run), 0) / bucket.length : 0;
  const ids: R5JitGroupId[] = ["cleanOffload", "earlyDirtyOffload", "lateOffload", "noJit"];
  return ids.map((group) => {
    const bucket = buckets[group];
    return {
      group,
      runs: bucket.length,
      avgTokens: avg(bucket, (run) => run.tokens.total),
      avgUncachedInput: avg(bucket, (run) => run.tokens.input),
      avgCacheRead: avg(bucket, (run) => run.tokens.cacheRead),
      avgOutput: avg(bucket, (run) => run.tokens.output),
      avgRounds: avg(bucket, (run) => run.rounds),
    };
  });
}

/** 报告里的分组结构：arm → task → R5JitGroup[]（全部 6 格，保持 schema 稳定）。 */
export type R5JitGroups = Record<R5Arm, Record<R5TaskId, R5JitGroup[]>>;

export function buildAllR5JitGroups(runs: readonly R5RunMetrics[]): R5JitGroups {
  return {
    control: {
      A: buildR5JitGroups(runs, "control", "A"),
      B: buildR5JitGroups(runs, "control", "B"),
      C: buildR5JitGroups(runs, "control", "C"),
    },
    treatment: {
      A: buildR5JitGroups(runs, "treatment", "A"),
      B: buildR5JitGroups(runs, "treatment", "B"),
      C: buildR5JitGroups(runs, "treatment", "C"),
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
  /** stop-after-submit：submit 后不再进模型 final 轮（协议冗余对照实验） */
  stopAfterSubmit?: boolean;
  /** boundary-policy：treatment 提示词追加 Offload 边界策略（report 记录用；可选，缺省不写） */
  boundaryPolicy?: boolean;
  /** R6.1 contract acquisition 模式（report 记录用；可选，缺省不写 = eager） */
  contractMode?: R6ContractMode;
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
        jitGroups: buildAllR5JitGroups(runs),
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
  stopAfterSubmit: boolean;
  /** boundary-policy：treatment 提示词追加 Offload 边界策略（--boundary-policy 开启） */
  boundaryPolicy: boolean;
}

export function parseFlags(argv: readonly string[]): R5CliFlags {
  const flags: R5CliFlags = { arm: "both", task: "all", samples: 1, rounds: 10, dslGuidance: "primitive", stopAfterSubmit: false, boundaryPolicy: false };
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
    if (key === "stop-after-submit" && value === undefined) flags.stopAfterSubmit = true;
    if (key === "boundary-policy" && value === undefined) flags.boundaryPolicy = true;
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

  const { arm, task, samples, rounds, candidates, dslGuidance, stopAfterSubmit, boundaryPolicy } = parseFlags(process.argv.slice(2));
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
        console.log(`  [mode] stopAfterSubmit=${stopAfterSubmit} boundaryPolicy=${boundaryPolicy}`);
        const run = await runR5Run(currentTask, currentArm, runtime, rounds, {
          dslGuidance,
          ...(stopAfterSubmit ? { stopAfterSubmit } : {}),
          ...(boundaryPolicy ? { boundaryPolicy } : {}),
        });
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
      const avgDup = agg.avgDuplicatedPipelineCalls === undefined ? "n/a" : agg.avgDuplicatedPipelineCalls.toFixed(1);
      console.log(
        `  [${taskId}] runs=${agg.runs} ` +
          `clean=${(agg.cleanOffloadRate * 100).toFixed(0)}% earlyDirty=${(agg.earlyDirtyOffloadRate * 100).toFixed(0)}% ` +
          `late=${(agg.lateOffloadRate * 100).toFixed(0)}% noJit=${(agg.noJitRate * 100).toFixed(0)}% ` +
          `dupPipeline=${avgDup} ` +
          `execSucceeded=${(agg.jitExecutionSucceededRate * 100).toFixed(0)}% ` +
          `semanticCorrect=${(agg.jitSemanticCorrectRate * 100).toFixed(0)}% ` +
          `jitFinishedWithoutFallback=${(agg.jitFinishedWithoutFallbackRate * 100).toFixed(0)}% ` +
          `unnecessary=${unnecessary} ` +
          `fallback=${(agg.fallbackRate * 100).toFixed(0)}% ` +
          `maxedOut=${(agg.maxedOutRate * 100).toFixed(0)}% ` +
          `taskCompleted=${(agg.taskCompletionRate * 100).toFixed(0)}% ` +
          `compressed=${agg.avgCompressedOps.toFixed(1)} ` +
          `correctCompressed=${agg.avgCorrectlyCompressedOps.toFixed(1)} ` +
          `rounds=${agg.avgRounds.toFixed(1)} tokens=${Math.round(agg.avgTokens)} ` +
          `offloadRound=${agg.avgOffloadDecisionRound.toFixed(1)} ` +
          `pre=${agg.avgPreOffloadBusinessCallCount.toFixed(1)} same=${agg.avgSameRoundBusinessCallCount.toFixed(1)} postExec=${agg.avgPostExecuteBusinessCallCount.toFixed(1)} ` +
          `preOffloadPipeline=${avgPipeline} timely=${timely} ` +
          `adoption=${(agg.adoptionRate * 100).toFixed(0)}% offloadPrecision=${(agg.offloadPrecision * 100).toFixed(0)}%`,
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
    {
      arm,
      task,
      samples,
      rounds,
      dslGuidance,
      ...(stopAfterSubmit ? { stopAfterSubmit } : {}),
      ...(boundaryPolicy ? { boundaryPolicy } : {}),
      ...(candidates !== undefined ? { candidates } : {}),
    },
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
