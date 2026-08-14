/**
 * R5 实验共享类型定义（依赖叶：只依赖 r5Tasks / agentRunner / dslReference 等外部类型，
 * 不依赖 r5OffloadingBenchmark，用于打破 shared 模块之间的环）。
 *
 * 环破例说明：CompileErrorBreakdown 与 CompressedPath 原与 classifyCompileErrorCode /
 * compressedPath 同文件，但二者都被 R5RunMetrics 引用，而 R5RunMetrics 收口在本叶模块——
 * 若留在 compileMetrics / offloadMetrics，会形成 types ⇄ compileMetrics / types ⇄ offloadMetrics
 * 的类型级 import 环。因此把它们一并上收到本模块，compileMetrics / offloadMetrics 从这里导入。
 */

import type { AgentTokenRound } from "../agentRunner.js";
import type { DslGuidanceMode } from "../../integrations/pi/dslReference.js";
import type { R5TaskId } from "../r5Tasks.js";

/** R6 contract acquisition 模式：eager = 历史 baseline（先 describe 拿契约再 execute）；compile-only = 无前置 describe、不挂 describe 工具，直接写程序，编译诊断兜底；manifest = compile-only + 紧凑 output manifest；eager-signatures = production/default（active tools 已随定义携带 DSL signature，无需 describe）。 */
export type R6ContractMode = "eager" | "compile-only" | "manifest" | "eager-signatures";

/**
 * R5/R6 历史实验的 contract acquisition 模式锚点（describe-first）。
 * 历史 benchmark（R5 offloading、R6 describe/eager 的 eager 臂）必须显式使用
 * 本常量，保证重跑时行为与历史基线一致——不要跟随生产默认漂移。
 */
export const HISTORICAL_R5_CONTRACT_MODE: R6ContractMode = "eager";

/**
 * 生产默认 contract acquisition 模式：active tools 已随定义携带 DSL signature，
 * agent 决定 offload 后直接 jit_execute_program，不走 describe 往返。
 * 新实验/生产入口必须显式传入本常量；绝不在代码里静默 `?? "eager"`。
 */
export const PRODUCTION_CONTRACT_MODE: R6ContractMode = "eager-signatures";

/**
 * R6.2：compile failure 诊断按 code 归三类，回答"opaque 是否真正制造了 contract uncertainty"。
 * 分类依据是 `DslDiagnostic.code`（编译器原始 code，非 JIT 层大写 code）。
 */
export interface CompileErrorBreakdown {
  /** 语法/完整性类（与 output contract 无关）：syntax / duplicate_name / missing_return / duplicate_return */
  syntaxOrCompleteness: number;
  /** output contract 类：UNKNOWN_FIELD / config_type_mismatch / unknown_parameter / MAP_BINDING_REF_INVALID */
  outputContractRelated: number;
  /** 其余（unknown_tool / undefined_reference / duplicate_argument / invalid_reference / expression_invalid / TOO_MANY_POSITIONAL_ARGS / schema_invalid 等） */
  other: number;
}

/** 一次 JIT 执行替代的原子操作统计（compressed path length）。 */
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
  /** project（字段投影）节点数量；旧存储形态缺省 0 */
  projectNodes?: number;
  /** collect（值包装成数组）节点数量；旧存储形态缺省 0 */
  collectNodes?: number;
  returnNodes: number;
  /** 原子操作总数：tool 节点 + map 展开执行数 + compute/merge/concat/project/collect/return 各一 */
  atomicOps: number;
}

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

/**
 * 一次 jit_execute_program 调用的编译/执行相位（round 为 1-based Agent round）。
 * 编译失败与执行失败在 tool 层都表现为 isError，需按错误文本前缀分类：
 * - 编译失败（renderCompileFailure 以"编译失败："开头）→ compileSuccess=false / executionSuccess=false；
 * - 执行失败（"执行失败："）→ compileSuccess=true / executionSuccess=false；
 * - 成功 → 两者皆 true。
 */
export interface R5ExecuteCallPhase {
  round: number;
  compileSuccess: boolean;
  executionSuccess: boolean;
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
  /** R6.1（编译/执行解耦）：首次 jit_execute_program 是否执行成功（编译失败 / 执行失败 / 无 execute 调用 → 分别 false / false / undefined；legacy 无 executeCallPhases 时回退 firstPassCompileSuccess 近似） */
  firstPassExecutionSuccess?: boolean;
  /** R6.1（编译/执行解耦）：是否存在至少一次编译成功的 jit_execute_program（legacy 回退 jitExecutionSucceeded 近似） */
  compileSucceeded?: boolean;
  /** R6.1：每次 jit_execute_program 的编译/执行相位（按 round 升序；新 run 由 runR5Run 采集，老报告/rescore 无此字段） */
  executeCallPhases?: readonly R5ExecuteCallPhase[];
  /** R6.1：首次失败到首次成功的修复轮数（首轮即成功 → 0；从未成功 → 总轮数 − 首次失败轮；无 execute → undefined） */
  repairRounds?: number;
  /** R6.1：是否在首次 execute 失败后才调用 jit_describe_tools（= 编译失败后的 describe 兜底；无 describe 或从未失败 → false；compile-only/manifest 臂不挂 describe 工具，恒 false；deriveR5Metrics 恒返回，声明为可选以兼容既有字面量构造的测试） */
  describeFallbackUsed?: boolean;
  /** R6.1：是否存在"先 describe 后 execute"（describe 调用轮 < 首次 execute 轮；无 describe 调用 → 省略该字段） */
  preDescribeUsed?: boolean;
  /** R6.1：repair 区间（首次失败轮 .. 首次成功轮/末尾）轮次的 tokenRounds total 之和（无 tokenRounds → undefined） */
  repairTokens?: number;
  /** R6.1：该 run 的 contract acquisition 模式（eager / compile-only / manifest / eager-signatures；runR5Run 透传；R6 分臂聚合的事实源） */
  contractMode?: R6ContractMode;
  /** R6.2：该 run 的工具输出命名（transparent / opaque；runR5Run 透传，R6.2 分格事实源） */
  toolNaming?: "transparent" | "opaque";
  /** R6.2：首次 jit_execute_program 即 compile+execute+semantic correct（无 execute → undefined） */
  firstPassSemanticSuccess?: boolean;
  /** R6.2：compile 失败诊断的三类计数（runR5Run 经 onCompileFailure 采集；无编译失败 → undefined） */
  compileErrorBreakdown?: CompileErrorBreakdown;
  /** R6.2：manifest 臂的 manifest 字符数 / 估算 token（非 manifest 臂 → undefined） */
  manifestChars?: number;
  manifestEstimatedTokens?: number;
  /** R6.2：首次 compile 前 token、repair 区间 token（与 repairTokens 同源）、首次成功执行后 token（无 tokenRounds → undefined） */
  tokensBeforeFirstCompile?: number;
  tokensInRepairRounds?: number;
  tokensAfterSuccessfulExecution?: number;
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
  /** 每次 jit_execute_program 的编译/执行相位（按 round 升序；新 run 由 runR5Run 采集，legacy 输入省略时回退旧 isError 口径近似） */
  executeCallPhases?: readonly R5ExecuteCallPhase[];
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
  /** R6.1（编译/执行解耦）：首次 execute 执行成功比例（firstPassExecutionSuccess === true / 格内总数，含未尝试 compile 的 run 作分母；legacy 无该字段的 run 不计数） */
  firstPassExecutionRate: number;
  /** R6.1：最终至少一次执行成功的比例（= jitExecutionSucceededRate，语义别名） */
  eventualExecutionRate: number;
  /** R6.1：最终语义正确的比例（= jitSemanticCorrectRate，语义别名） */
  eventualSemanticCorrectRate: number;
  /** R6.1（编译/执行解耦，重定义）：最终至少一次编译成功的比例（compileSucceeded === true / 格内总数；原为 jitExecutionSucceededRate 别名，现按编译层面统计） */
  eventualCompileRate: number;
  /** R6.1：平均修复轮数（repairRounds 有定义值的均值） */
  avgRepairRounds: number;
  /** R6.1：describeFallbackUsed === true 比例（compile-only/manifest 臂不挂 describe 工具，恒 0；eager 臂指"首次 execute 失败后兜底 describe"的频率） */
  describeFallbackRate: number;
  /** R6.1：preDescribeUsed === true 比例（先 describe 后 execute 的 run 占比） */
  preDescribeUsedRate: number;
  /** R6.1：平均 repairTokens（有定义值的均值；无 → undefined） */
  avgRepairTokens: number | undefined;
  /** R6.2：平均编译尝试次数（compileAttempts 有定义值的均值） */
  avgCompileAttempts: number;
  /** R6.2：平均延迟（ms） */
  avgLatencyMs: number;
  /** R6.2：首次 execute 即 compile+execute+semantic correct 的比例（firstPassSemanticSuccess===true / 格内总数） */
  firstPassSemanticSuccessRate: number;
  /** R6.2：output contract 相关编译错误占比（格内 outputContractRelated 总数 / 三类诊断总数；无诊断 → 0） */
  outputContractErrorRate: number;
  /** R6.2：语法/完整性编译错误占比（格内 syntaxOrCompleteness 总数 / 三类诊断总数；无诊断 → 0） */
  syntaxCompletenessErrorRate: number;
}

/** 报告里的汇总结构：arm → task → aggregate。 */
export type R5Aggregates = Record<R5Arm, Record<R5TaskId, R5Aggregate>>;

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

/** 报告里的分组结构：arm → task → R5JitGroup[]（全部 6 格，保持 schema 稳定）。 */
export type R5JitGroups = Record<R5Arm, Record<R5TaskId, R5JitGroup[]>>;

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
  /** reasoning 开关（显式冻结，不依赖 gateway 默认值；--reasoning 开启） */
  reasoningEnabled?: boolean;
  /** R6.1 contract acquisition 模式（report 记录用；可选，缺省不写 = eager） */
  contractMode?: R6ContractMode;
}
