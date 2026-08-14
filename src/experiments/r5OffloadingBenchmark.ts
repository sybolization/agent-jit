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

import { createDeepSeekPiRuntime, type PiRuntime } from "../llm/gateway.js";
import { adaptRegisteredTool, createPiTools } from "../integrations/pi/toolAdapter.js";
import { renderNeutralDslReference, type DslGuidanceMode } from "../integrations/pi/dslReference.js";
import type { JitExecuteProgramDetails } from "../integrations/pi/jit.js";
import type { RegisteredTool } from "../tools/definition.js";
import { DESCRIBE_TOOLS_TOOL, EXECUTE_PROGRAM_TOOL } from "../tools/jitTools.js";
import { renderCompactManifest } from "../tools/compactContractRenderer.js";
import { ToolRegistry } from "../tools/registry.js";
import { checkTaskSemantics } from "./taskSpec.js";
import { runPiAgent, type AgentReasoningTurn } from "./agentRunner.js";
import { createR5CTask, R5_TASKS, type R5Task, type R5TaskId } from "./r5Tasks.js";
import type { DslDiagnostic } from "../language/diagnostics.js";

import { buildR5Aggregates, deriveR5Metrics } from "./shared/agentJitRun.js";
import { compressedPath } from "./shared/offloadMetrics.js";
import { compileErrorBreakdown } from "./shared/compileMetrics.js";
import { createR5SubmitTool, SUBMIT_ANSWER_ID, submitAnswerTool } from "./shared/submitAnswer.js";
import { writeR5Report } from "./shared/experimentReport.js";
import type { R5Arm, R5ExecuteCallPhase, R5RunMetrics, R6ContractMode } from "./shared/types.js";
import { HISTORICAL_R5_CONTRACT_MODE } from "./shared/types.js";

export * from "./shared/types.js";
export * from "./shared/compileMetrics.js";
export * from "./shared/offloadMetrics.js";
export * from "./shared/agentJitRun.js";
export * from "./shared/experimentReport.js";
export { createR5SubmitTool };

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

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
 *
 * R6.1 起按 contractMode 渲染 handoff 行：
 * - eager（历史）：先 describe + execute；
 * - 其余（compile-only / manifest / eager-signatures）：直接提交完整 program，
 *   不再出现 describe——防止 eager 模式的描述泄漏进无 describe 的臂。
 */
export function boundaryPolicyRules(contractMode: R6ContractMode): readonly string[] {
  const common = [
    "判断是否把一段后续工作交给 JIT：依据是这段工作的后续决策规则（过滤阈值、排序键、截取数量等）是否已经由任务确定——只要决策规则已确定，即使数据还没拿到，也可以立即把整段工作一次性程序化；不要在确定可程序化之后，还先用普通工具把数据逐个做一遍。",
  ];
  const handoff =
    contractMode === "eager"
      ? "一旦决定把某个确定性片段 offload 给 JIT，就不要在同一个 assistant turn 里再并行调用该片段涉及的普通业务工具（包括与 describe / execute 同一轮发出的调用）——那会造成重复工作；先 describe + execute，看到 JIT 结果后再判断是否需要补救。"
      : "一旦决定把某个确定性片段 offload 给 JIT，就不要在同一个 assistant turn 里再并行调用该片段涉及的普通业务工具（包括与 execute 同一轮发出的调用）——那会造成重复工作；直接提交完整的 JIT program，看到结果后再判断是否需要补救。";
  return [...common, handoff];
}

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
  const contractMode = options?.contractMode ?? HISTORICAL_R5_CONTRACT_MODE;
  // 各模式的 JIT 说明行：
  // - eager（历史）：先 describe 拿契约，再 execute；
  // - eager-signatures（production/default）：直接 execute，DSL 签名已随工具定义提供；
  // - compile-only / manifest：直接 execute，编译失败按结构化诊断修正（不提供 describe 工具）。
  const jitLine =
    contractMode === "eager"
      ? `- Agent JIT：将已经确定的多步工具操作编译执行——需要时先用 ${DESCRIBE_TOOLS_TOOL.name} 获取编程契约（返回 DSL 语法极简参考 + 你要编排工具的契约），再用 ${EXECUTE_PROGRAM_TOOL.name} 提交程序。`
      : contractMode === "eager-signatures"
        ? `- Agent JIT：将已经确定的多步工具操作编译执行——直接调用 ${EXECUTE_PROGRAM_TOOL.name} 提交程序；每个工具的 DSL 签名（输入参数与输出字段）已随工具定义提供。`
        : `- Agent JIT：将已经确定的多步工具操作编译执行——直接调用 ${EXECUTE_PROGRAM_TOOL.name} 提交程序；编译失败会返回结构化诊断（含可用字段/参数名），按诊断修正后重试即可。`;
  return [
    "你是一个自主 Agent，需要完成用户交给的任务。你有两类工具：",
    "- 普通业务工具：直接调用（工具名与参数见工具定义），适合单次查询/操作。",
    jitLine,
    "",
    "是否使用 JIT 由你决定：单个查询用普通工具即可；一段后续工作可以确定性程序化（对列表每个元素做同样处理、过滤/排序/合并/取前 N 等）时再考虑 JIT。",
    `完成所有工具调用后，调用 ${SUBMIT_ANSWER_ID}(answer="...") 提交最终答案（最终答案的唯一提交通道，不要只写在普通文本里）。`,
    // 无前置 describe 的臂（compile-only / manifest / eager-signatures）：DSL 语言语义（无任何工具契约）
    // 常驻提示词。compile-only / manifest 先加一行澄清：工具参数名/类型以工具定义为准（模型可见），
    // 输出字段在编译前未知——交给编译诊断指出；eager-signatures 输出字段已通过 DSL signature 可见，不追加该澄清。
    ...(contractMode === "compile-only" || contractMode === "manifest" || contractMode === "eager-signatures"
      ? [
          "",
          ...(contractMode === "compile-only" || contractMode === "manifest"
            ? ["工具的参数名与类型以你的工具定义为准（你已可见）；输出字段在编译前未知——先写程序提交，编译诊断会指出不存在的字段并列出可用字段。"]
            : []),
          renderNeutralDslReference(),
        ]
      : []),
    // manifest：再追加紧凑 output manifest（只含工具输出形状）
    ...(contractMode === "manifest" && options?.manifest !== undefined && options.manifest.length > 0
      ? ["", "## Output manifest", options.manifest]
      : []),
    // 边界策略段最后追加（eager 下为空数组，顺序与现状一致 → 输出逐字节不变）
    ...(options?.boundaryPolicy === true
      ? ["", "## Offload 边界策略", ...boundaryPolicyRules(contractMode).map((rule, index) => `${index + 1}. ${rule}`)]
      : []),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 单次运行
// ---------------------------------------------------------------------------

export interface R5RunOptions {
  dslGuidance?: DslGuidanceMode;
  /** reasoning observation：runPiAgent 完成后回调该 run 的全部 reasoningTurns（附加式，不进 R5RunMetrics/report） */
  onReasoningTurns?: (turns: readonly AgentReasoningTurn[]) => void;
  /** stop-after-submit：submit_answer 执行后 agent 直接结束（不再生成最终文本轮）；默认 false = 旧行为 */
  stopAfterSubmit?: boolean;
  /** boundary-policy：treatment 常驻提示词追加 Offload 边界策略（两条规则）；默认 false = 旧极简提示词 */
  boundaryPolicy?: boolean;
  /** R6.1 contract acquisition 模式：缺省 eager = 历史（先 describe 拿契约再 execute）；compile-only / manifest = 直接 execute + 结构化诊断兜底（describeTools:false，不挂 describe 工具）；eager-signatures = production/default（active tools 已带 DSL signature，无需 describe） */
  contractMode?: R6ContractMode;
  /** R6.2：工具输出命名（transparent / opaque），runR5Run 透传到 R5RunMetrics 供分格 */
  toolNaming?: "transparent" | "opaque";
}

export async function runR5Run(
  task: R5Task,
  arm: R5Arm,
  runtime: PiRuntime,
  maxRounds = 10,
  options: R5RunOptions = {},
): Promise<R5RunMetrics> {
  const registry = new ToolRegistry<RegisteredTool>([...task.tools, submitAnswerTool]);
  // R6.2：编译失败诊断采集（onCompileFailure 汇总）与首个成功程序（firstPassSemanticSuccess 用）
  const compileDiagnostics: DslDiagnostic[] = [];
  let firstProgramDetails: JitExecuteProgramDetails | undefined;
  // R6.2：manifest 臂的 manifest 文本（同时供 systemPrompt 与 manifestChars/EstimatedTokens）
  const manifestText = options.contractMode === "manifest" ? renderCompactManifest(registry) : "";
  // 双 arm 唯一差异：control 只有 atomic tools（含 submit_answer）；treatment 再挂上 jit_* 元工具。
  // dslGuidance 只影响 treatment 臂（jit_describe_tools 的 manual/bindings 渲染），control 臂无 JIT 不受影响。
  const piTools = (arm === "control"
    ? registry.all().map((tool) => adaptRegisteredTool(registry, tool))
    : createPiTools(registry, {
        guidance: options.dslGuidance,
        ...(options.contractMode === "compile-only" || options.contractMode === "manifest" || options.contractMode === "eager-signatures"
          ? {}
          : { describeTools: true, describeFormat: "legacy" as const, legacyBundle: true }),
        // 只有 eager-signatures / production 才注入 inline DSL signature，保证历史臂的 contract visibility 隔离。
        dslSignatures: options.contractMode === "eager-signatures",
        onCompileFailure: (diagnostics) => compileDiagnostics.push(...diagnostics),
      })
  ).map((tool) => (tool.name === SUBMIT_ANSWER_ID && options.stopAfterSubmit ? createR5SubmitTool(true) : tool));

  let describeCalls = 0;
  let executeCalls = 0;
  const businessCalls: string[] = [];
  const executeErrors: string[] = [];
  /** 每次 jit_execute_program 的编译/执行相位（push 顺序 = 执行顺序 = round 升序；最后统一排序） */
  const executeCallPhases: R5ExecuteCallPhase[] = [];
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
            ...(options.contractMode === "manifest" && manifestText.length > 0 ? { manifest: manifestText } : {}),
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
    onToolEnd: ({ name, isError, result, round }) => {
      if (name !== EXECUTE_PROGRAM_TOOL.name) return;
      const details = (result as { details?: JitExecuteProgramDetails } | null)?.details;
      if (details && details.status === "success") {
        lastProgramDetails = details;
        if (firstProgramDetails === undefined) firstProgramDetails = details;
        executeCallPhases.push({ round, compileSuccess: true, executionSuccess: true });
        return;
      }
      if (isError) {
        const text =
          (result as { content?: Array<{ text?: string }> } | null)?.content?.map((c) => c.text ?? "").join("") ?? "";
        // 编译/执行解耦：按错误文本前缀分类（jit.ts 的 renderCompileFailure 以"编译失败："开头、
        // 执行失败以"执行失败："开头）——编译失败 → 两者皆 false；执行失败 → 编译已过但执行未过；
        // 其它（如 source 为空）按最保守的"编译未过"计。
        if (text.includes("编译失败")) {
          executeCallPhases.push({ round, compileSuccess: false, executionSuccess: false });
        } else if (text.includes("执行失败")) {
          executeCallPhases.push({ round, compileSuccess: true, executionSuccess: false });
        } else {
          executeCallPhases.push({ round, compileSuccess: false, executionSuccess: false });
        }
        if (text.trim() && executeErrors.length < 5) executeErrors.push(text.trim().slice(0, 300));
      }
    },
  });

  // reasoning observation：透传该 run 的全部 reasoningTurns（附加式，不进 R5RunMetrics/report）
  options.onReasoningTurns?.(run.reasoningTurns);

  let lastProgram: R5RunMetrics["lastProgram"];
  let jitSemanticCorrect: boolean | undefined;
  if (lastProgramDetails) {
    // 执行级语义判定：用任务同一套 mock 工具执行程序、按 answerField 与 oracle 比较
    // （拓扑无关；checkTaskCorrectness 的固定结构检查会误判语义等价的程序，不再用于 R5 语义判定）
    jitSemanticCorrect = task.spec
      ? (await checkTaskSemantics(lastProgramDetails.graph, task)).pass
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
    // 按 round 升序（同一 round 内多个 execute 调用的相对顺序不参与语义，排序保证稳定）
    executeCallPhases: executeCallPhases.sort((a, b) => a.round - b.round),
    pipelineToolIds: task.pipelineToolIds,
    lastProgramSource: lastProgramDetails?.source,
    submittedAnswer,
    finalText: run.finalText,
    oracle: task.oracle,
    ...(run.error !== undefined ? { error: run.error } : {}),
  });

  // R6.2：首次 execute 即 compile+execute+semantic correct（比 firstPassCompileSuccess 更强）
  let firstPassSemanticSuccess: boolean | undefined;
  if (executeCallPhases.length > 0 && task.spec) {
    const first = executeCallPhases[0]!;
    if (first.compileSuccess && first.executionSuccess) {
      firstPassSemanticSuccess = firstProgramDetails
        ? (await checkTaskSemantics(firstProgramDetails.graph, task)).pass
        : undefined;
    } else {
      firstPassSemanticSuccess = false;
    }
  }
  // R6.2：compile 失败诊断的三类计数
  const errorBreakdown = compileDiagnostics.length > 0 ? compileErrorBreakdown(compileDiagnostics) : undefined;

  return {
    ...metrics,
    ...(options.contractMode !== undefined ? { contractMode: options.contractMode } : {}),
    ...(options.toolNaming !== undefined ? { toolNaming: options.toolNaming } : {}),
    ...(firstPassSemanticSuccess !== undefined ? { firstPassSemanticSuccess } : {}),
    ...(errorBreakdown !== undefined ? { compileErrorBreakdown: errorBreakdown } : {}),
    ...(manifestText.length > 0
      ? { manifestChars: manifestText.length, manifestEstimatedTokens: Math.ceil(manifestText.length / 4) }
      : {}),
    ...(lastProgram ? { lastProgram } : {}),
    ...(executeCallPhases.length > 0 ? { executeCallPhases } : {}),
  };
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
  /** reasoning：模型思考开关（--reasoning 开启；缺省 false，显式冻结，不依赖 gateway 默认值） */
  reasoning: boolean;
}

export function parseFlags(argv: readonly string[]): R5CliFlags {
  const flags: R5CliFlags = {
    arm: "both",
    task: "all",
    samples: 1,
    rounds: 10,
    dslGuidance: "primitive",
    stopAfterSubmit: false,
    boundaryPolicy: false,
    reasoning: false,
  };
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
    if (key === "reasoning" && value === undefined) flags.reasoning = true;
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

  const { arm, task, samples, rounds, candidates, dslGuidance, stopAfterSubmit, boundaryPolicy, reasoning } = parseFlags(process.argv.slice(2));
  const tasks = R5_TASKS.filter((item) => task === "all" || item.id === task).map((item) =>
    candidates !== undefined && item.id === "C" ? createR5CTask(candidates) : item,
  );
  const arms: R5Arm[] = arm === "both" ? ["control", "treatment"] : [arm];
  // reasoning 显式冻结：只认 CLI 标志，不依赖 gateway 默认值（历史重跑需 --reasoning 复现旧行为）
  const runtime = createDeepSeekPiRuntime({ reasoning });

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
      reasoningEnabled: reasoning,
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
