import type { AgentTokenRound } from "./agentRunner.js";

/**
 * R5 Token phase 分类 —— 按每轮 tool calls 机械归类，回答"token 花在哪个阶段"。
 *
 * 规则（不要强行把 mixed 算成 JIT 或 atomic）：
 * - 无 tool call → finalization；
 * - 工具名分桶：jit_describe_tools → jit-describe、jit_execute_program → jit-program、
 *   submit_answer → submission、其余（业务工具）→ atomic-execution；
 * - 单桶 → 该 phase；≥2 桶（如 jit_describe_tools + 业务工具）→ mixed。
 * mixed round 本身就是 boundary 不干净的重要信号。
 */

export type TokenRoundPhase =
  | "atomic-execution"
  | "jit-describe"
  | "jit-program"
  | "submission"
  | "finalization"
  | "mixed";

export const JIT_DESCRIBE_TOOL_NAME = "jit_describe_tools";
export const JIT_EXECUTE_TOOL_NAME = "jit_execute_program";
export const SUBMIT_ANSWER_TOOL_NAME = "submit_answer";

export function classifyTokenRound(toolNames: readonly string[]): TokenRoundPhase {
  if (toolNames.length === 0) return "finalization";
  const buckets = new Set<TokenRoundPhase>();
  for (const name of toolNames) {
    if (name === JIT_DESCRIBE_TOOL_NAME) buckets.add("jit-describe");
    else if (name === JIT_EXECUTE_TOOL_NAME) buckets.add("jit-program");
    else if (name === SUBMIT_ANSWER_TOOL_NAME) buckets.add("submission");
    else buckets.add("atomic-execution");
  }
  if (buckets.size === 1) {
    for (const phase of buckets) return phase;
  }
  return "mixed";
}

export interface TokenTotals {
  input: number;
  cacheRead: number;
  output: number;
  total: number;
}

/** 按 phase 累计一个 run 的全部 tokenRounds（每个 round 唯一归类，不漏 token）。 */
export function sumTokenRoundsByPhase(
  tokenRounds: readonly AgentTokenRound[],
): Record<TokenRoundPhase, TokenTotals> {
  const sums: Record<TokenRoundPhase, TokenTotals> = {
    "atomic-execution": { input: 0, cacheRead: 0, output: 0, total: 0 },
    "jit-describe": { input: 0, cacheRead: 0, output: 0, total: 0 },
    "jit-program": { input: 0, cacheRead: 0, output: 0, total: 0 },
    submission: { input: 0, cacheRead: 0, output: 0, total: 0 },
    finalization: { input: 0, cacheRead: 0, output: 0, total: 0 },
    mixed: { input: 0, cacheRead: 0, output: 0, total: 0 },
  };
  for (const round of tokenRounds) {
    const phase = classifyTokenRound(round.toolCalls);
    sums[phase].input += round.input;
    sums[phase].cacheRead += round.cacheRead;
    sums[phase].output += round.output;
    sums[phase].total += round.total;
  }
  return sums;
}

/**
 * atomic-execution 轮的 stage 归类（P1：让 Control 的成本结构可见）。
 * B 型流水线的三个阶段：search（搜索 root）→ details（fanout 拉详情）→ scoring（分支打分）；
 * 其余工具归 other（generic atomic stage 兜底）。
 */
export type AtomicStage = "search" | "details" | "scoring" | "other";

export function classifyAtomicStage(toolName: string): AtomicStage {
  if (toolName === "github_search_repositories") return "search";
  if (toolName === "github_get_repository") return "details";
  if (toolName === "github_get_contributor_stats" || toolName === "github_list_commits") return "scoring";
  return "other";
}

/**
 * 只统计 atomic-execution phase 的轮，按"首个业务工具"归 stage，每轮唯一归类（token 不重复分配）。
 * atomic 轮的定义（classifyTokenRound === "atomic-execution"）已保证全部工具都是业务工具。
 */
export function sumAtomicStagesByStage(
  tokenRounds: readonly AgentTokenRound[],
): Record<AtomicStage, TokenTotals> {
  const sums: Record<AtomicStage, TokenTotals> = {
    search: { input: 0, cacheRead: 0, output: 0, total: 0 },
    details: { input: 0, cacheRead: 0, output: 0, total: 0 },
    scoring: { input: 0, cacheRead: 0, output: 0, total: 0 },
    other: { input: 0, cacheRead: 0, output: 0, total: 0 },
  };
  for (const round of tokenRounds) {
    if (classifyTokenRound(round.toolCalls) !== "atomic-execution") continue;
    const stage = classifyAtomicStage(round.toolCalls[0] ?? "");
    sums[stage].input += round.input;
    sums[stage].cacheRead += round.cacheRead;
    sums[stage].output += round.output;
    sums[stage].total += round.total;
  }
  return sums;
}
