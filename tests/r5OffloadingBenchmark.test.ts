import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { compileExecutionDsl } from "../src/compiler/compile.js";
import { execute } from "../src/runtime/runtime.js";
import { checkTaskCorrectness } from "../src/experiments/taskSpec.js";
import type { RegisteredTool } from "../src/tools/definition.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { R5_TASKS, type R5TaskId } from "../src/experiments/r5Tasks.js";
import {
  parseFlags,
  aggregateR5,
  buildR5Aggregates,
  compressedPath,
  deriveR5Metrics,
  r5ControlSystemPrompt,
  r5TreatmentSystemPrompt,
  writeR5Report,
  type R5Arm,
  type R5RunDerivationInput,
  type R5RunMetrics,
  type R5ToolCallRecord,
} from "../src/experiments/r5OffloadingBenchmark.js";

/** toolTimeline 记录构造辅助（round 默认 1；arguments 默认空）。 */
const call = (name: string, round = 1, isError = false): R5ToolCallRecord => ({
  name,
  isError,
  round,
  arguments: {},
});

describe("系统提示词：两个 arm 的唯一差异是 JIT 能力", () => {
  test("control：普通 Agent + submit_answer，完全不知道 JIT", () => {
    const prompt = r5ControlSystemPrompt();
    expect(prompt).toContain("自主 Agent");
    expect(prompt).toContain("submit_answer");
    expect(prompt).not.toContain("jit_");
    expect(prompt).not.toContain("DSL");
  });

  test("treatment：常驻极简（不内嵌 DSL 语法/示例）——是否使用 JIT 由模型决定", () => {
    const prompt = r5TreatmentSystemPrompt();
    expect(prompt).toContain("jit_describe_tools");
    expect(prompt).toContain("jit_execute_program");
    expect(prompt).toContain("submit_answer");
    expect(prompt).toContain("由你决定");
    // DSL manual 已按需加载（jit_describe_tools 首次调用返回）——常驻 prompt 不含语法关键字/示例
    expect(prompt).not.toContain("map(");
    expect(prompt).not.toContain("join(");
    expect(prompt).not.toContain("compute(");
    expect(prompt).not.toContain("<name> = <callee>");
    expect(prompt).not.toContain("必须用");
  });
});

describe("compressedPath — 一次 jit_execute_program 压缩了多少原子操作", () => {
  const C_DSL = [
    "cands = github.get_issues(numbers=[1, 3, 5, 7])",
    "scores = map(cands, github.get_issue_score(number=_.number))",
    'ranked = sort(scores, key="score", desc=true)',
    "top = take(ranked, 2)",
    "return top",
  ].join("\n");

  test("C 型程序：tool=1 + map fanout=4 + sort/take + return", async () => {
    const task = R5_TASKS.find((item) => item.id === "C")!;
    const registry = new ToolRegistry<RegisteredTool>(task.tools);
    const { graph } = compileExecutionDsl(C_DSL, { tools: registry });
    const execution = await execute(graph, registry);
    expect(execution.status).toBe("success");

    const compressed = compressedPath(graph, execution.trace);
    expect(compressed.toolNodes).toBe(1); // github.get_issues
    expect(compressed.mapNodes).toBe(1); // map scores
    expect(compressed.fanoutSum).toBe(4); // 4 个候选的实际执行数
    expect(compressed.computeNodes).toBe(2); // sort + take
    expect(compressed.mergeNodes).toBe(0);
    expect(compressed.concatNodes).toBe(0);
    expect(compressed.returnNodes).toBe(1);
    expect(compressed.atomicOps).toBe(1 + 4 + 2 + 0 + 0 + 1);
  });

  test("graph 为空数组时全部为 0", () => {
    const compressed = compressedPath({ schema_version: "1", nodes: [] }, []);
    expect(compressed.atomicOps).toBe(0);
    expect(compressed.fanoutSum).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// deriveR5Metrics —— P0 严格 correctness 回归（纯函数，不跑模型）
// ---------------------------------------------------------------------------

const deriveInput = (
  overrides: Partial<R5RunDerivationInput> & { taskId: R5TaskId },
): R5RunDerivationInput => ({
  arm: "treatment",
  rounds: 3,
  maxedOut: false,
  tokens: { input: 1, output: 1, cacheRead: 0, total: 2 },
  latencyMs: 0,
  toolTimeline: [],
  businessCalls: [],
  describeCalls: 0,
  executeCalls: 0,
  jitSemanticCorrect: undefined,
  executeErrors: [],
  pipelineToolIds: R5_TASKS.find((task) => task.id === overrides.taskId)?.pipelineToolIds,
  finalText: "",
  oracle: [],
  ...overrides,
});

describe("deriveR5Metrics — P0：dslCorrect=false 必须 fail（错误程序 result 不再参与答案判定）", () => {
  const B_ORACLE = ["adv/org-repo-0", "adv/org-repo-1", "adv/org-repo-17"];

  test("B 型坏 case：执行成功但语义错误、无 fallback、跑满轮数 → taskCompleted=false（即使提交答案包含 repo 名）", () => {
    const metrics = deriveR5Metrics(
      deriveInput({
        taskId: "B",
        rounds: 8,
        maxedOut: true,
        toolTimeline: [
          call("jit_describe_tools"),
          call("jit_execute_program"), // 执行成功
        ],
        describeCalls: 1,
        executeCalls: 1,
        jitSemanticCorrect: false,
        // 旧实现会因“错误程序 result 包含这三个 repo”而误判 answerCorrect=true
        submittedAnswer: "前 3 个：adv/org-repo-0、adv/org-repo-1、adv/org-repo-17",
        finalText: "",
        oracle: B_ORACLE,
      }),
    );
    expect(metrics.jitAttempted).toBe(true);
    expect(metrics.jitExecutionSucceeded).toBe(true);
    expect(metrics.jitSemanticCorrect).toBe(false);
    expect(metrics.fallbackUsed).toBe(false);
    expect(metrics.maxedOut).toBe(true);
    expect(metrics.answerCorrect).toBe(true); // 答案字符串本身匹配
    expect(metrics.taskCompleted).toBe(false); // 但严格语义：必须 fail
  });

  test("B 型坏 case + fallback 补救：JIT 后改用普通业务工具 → taskCompleted 恢复为 answerCorrect", () => {
    const metrics = deriveR5Metrics(
      deriveInput({
        taskId: "B",
        toolTimeline: [
          call("jit_describe_tools"),
          call("jit_execute_program"),
          call("github_get_repository"), // fallback 补救
        ],
        businessCalls: ["github_get_repository"],
        describeCalls: 1,
        executeCalls: 1,
        jitSemanticCorrect: false,
        submittedAnswer: "adv/org-repo-0, adv/org-repo-1, adv/org-repo-17",
        oracle: B_ORACLE,
      }),
    );
    expect(metrics.fallbackUsed).toBe(true);
    expect(metrics.answerCorrect).toBe(true);
    expect(metrics.taskCompleted).toBe(true);
  });

  test("JIT 之后的 submit_answer 不算 fallback（不触发补救判定）", () => {
    const metrics = deriveR5Metrics(
      deriveInput({
        taskId: "B",
        toolTimeline: [
          call("jit_execute_program"),
          call("submit_answer"),
        ],
        executeCalls: 1,
        jitSemanticCorrect: true,
        submittedAnswer: "adv/org-repo-0",
        oracle: ["adv/org-repo-0"],
      }),
    );
    expect(metrics.fallbackUsed).toBe(false);
    expect(metrics.taskCompleted).toBe(true);
  });

  test("B 型好 case：语义正确 + 答案正确 → taskCompleted=true", () => {
    const metrics = deriveR5Metrics(
      deriveInput({
        taskId: "B",
        toolTimeline: [call("jit_execute_program")],
        executeCalls: 1,
        jitSemanticCorrect: true,
        submittedAnswer: "adv/org-repo-0 / adv/org-repo-1 / adv/org-repo-17",
        oracle: B_ORACLE,
      }),
    );
    expect(metrics.taskCompleted).toBe(true);
  });

  test("A 型普通路径：不尝试 JIT，答案正确 → taskCompleted=true", () => {
    const metrics = deriveR5Metrics(
      deriveInput({
        taskId: "A",
        submittedAnswer: "1600，TypeScript",
        oracle: [/1[,，]?600/, "TypeScript"],
      }),
    );
    expect(metrics.jitAttempted).toBe(false);
    expect(metrics.answerCorrect).toBe(true);
    expect(metrics.taskCompleted).toBe(true);
  });

  test("未提交 submit_answer → answerCorrect=false（P0：不再从 finalText 判正确）", () => {
    const metrics = deriveR5Metrics(
      deriveInput({ taskId: "A", submittedAnswer: undefined, finalText: "star 1600，语言 TypeScript", oracle: [/1[,，]?600/, "TypeScript"] }),
    );
    expect(metrics.submittedAnswer).toBeUndefined();
    expect(metrics.answerCorrect).toBe(false);
    expect(metrics.taskCompleted).toBe(false);
  });

  test("P0 严格门控：jitSemanticCorrect === undefined（A 型上的尝试 / 执行失败）不视为完成，除非 fallback 补救", () => {
    const withoutFallback = deriveR5Metrics(
      deriveInput({
        taskId: "A",
        toolTimeline: [call("jit_execute_program", 1, true)],
        executeCalls: 1,
        jitSemanticCorrect: undefined,
        submittedAnswer: "1600，TypeScript",
        oracle: [/1[,，]?600/, "TypeScript"],
      }),
    );
    expect(withoutFallback.jitAttempted).toBe(true);
    expect(withoutFallback.taskCompleted).toBe(false); // undefined 不再放行

    const withFallback = deriveR5Metrics(
      deriveInput({
        taskId: "A",
        toolTimeline: [
          call("jit_execute_program", 1, true),
          call("github_get_repository"),
        ],
        businessCalls: ["github_get_repository"],
        executeCalls: 1,
        jitSemanticCorrect: undefined,
        submittedAnswer: "1600，TypeScript",
        oracle: [/1[,，]?600/, "TypeScript"],
      }),
    );
    expect(withFallback.fallbackUsed).toBe(true);
    expect(withFallback.taskCompleted).toBe(true);
  });

  test("jitFinishedWithoutFallback：尝试 + 语义正确 + 无 fallback = true；有 fallback / 语义错 = false", () => {
    const good = deriveR5Metrics(
      deriveInput({
        taskId: "B",
        toolTimeline: [call("jit_execute_program")],
        executeCalls: 1,
        jitSemanticCorrect: true,
        submittedAnswer: "adv/org-repo-0",
        oracle: ["adv/org-repo-0"],
      }),
    );
    expect(good.jitFinishedWithoutFallback).toBe(true);

    const withFallback = deriveR5Metrics(
      deriveInput({
        taskId: "B",
        toolTimeline: [
          call("jit_execute_program"),
          call("github_get_repository"),
        ],
        businessCalls: ["github_get_repository"],
        executeCalls: 1,
        jitSemanticCorrect: true,
        submittedAnswer: "adv/org-repo-0",
        oracle: ["adv/org-repo-0"],
      }),
    );
    expect(withFallback.jitFinishedWithoutFallback).toBe(false); // 用了 fallback，不算 JIT 独立完成

    const wrong = deriveR5Metrics(
      deriveInput({
        taskId: "B",
        toolTimeline: [call("jit_execute_program")],
        executeCalls: 1,
        jitSemanticCorrect: false,
        submittedAnswer: "adv/org-repo-0",
        oracle: ["adv/org-repo-0"],
      }),
    );
    expect(wrong.jitFinishedWithoutFallback).toBe(false);
    expect(wrong.taskCompleted).toBe(false);
  });
});

describe("deriveR5Metrics — offload 时机（P0：jitFinishedWithoutFallback 不反映“是否及时”）", () => {
  const B_ORACLE = ["adv/org-repo-0", "adv/org-repo-1", "adv/org-repo-17"];

  test("B 型理想 run：第一轮就 JIT、之前零业务调用 → offloadDecisionRound=1、timelyOffload=true", () => {
    const metrics = deriveR5Metrics(
      deriveInput({
        taskId: "B",
        toolTimeline: [call("jit_describe_tools", 1), call("jit_execute_program", 1), call("submit_answer", 2)],
        describeCalls: 1,
        executeCalls: 1,
        jitSemanticCorrect: true,
        submittedAnswer: "adv/org-repo-0 / adv/org-repo-1 / adv/org-repo-17",
        oracle: B_ORACLE,
      }),
    );
    expect(metrics.offloadDecisionRound).toBe(1);
    expect(metrics.preJitBusinessCallCount).toBe(0);
    expect(metrics.postJitBusinessCallCount).toBe(0);
    expect(metrics.preOffloadPipelineCalls).toBe(0);
    expect(metrics.timelyOffload).toBe(true);
  });

  test("B 型 28k 坏 run：JIT 前已执行 search+30×get_repository → preOffloadPipelineCalls=31、timelyOffload=false", () => {
    const details = Array.from({ length: 30 }, () => call("github_get_repository", 1));
    const metrics = deriveR5Metrics(
      deriveInput({
        taskId: "B",
        toolTimeline: [
          call("github_search_repositories", 1),
          ...details,
          call("jit_describe_tools", 2),
          call("jit_execute_program", 3),
          call("submit_answer", 4),
        ],
        businessCalls: ["github_search_repositories", ...details.map(() => "github_get_repository")],
        describeCalls: 1,
        executeCalls: 1,
        jitSemanticCorrect: true,
        submittedAnswer: "adv/org-repo-0 / adv/org-repo-1 / adv/org-repo-17",
        oracle: B_ORACLE,
      }),
    );
    expect(metrics.jitFinishedWithoutFallback).toBe(true); // correctness 层面没错
    expect(metrics.offloadDecisionRound).toBe(2);
    expect(metrics.preJitBusinessCallCount).toBe(31);
    expect(metrics.preOffloadPipelineCalls).toBe(31); // 最贵的 iterative 部分已被普通工具做完
    expect(metrics.timelyOffload).toBe(false); // 但 offload boundary 太晚，不是及时 offload
  });

  test("JIT 后仍有业务调用 → preJit/postJit 分界正确，且这些不算 timely（语义错时）", () => {
    const metrics = deriveR5Metrics(
      deriveInput({
        taskId: "B",
        toolTimeline: [
          call("jit_describe_tools", 1),
          call("jit_execute_program", 2),
          call("github_get_repository", 3), // JIT 后补救
        ],
        businessCalls: ["github_get_repository"],
        describeCalls: 1,
        executeCalls: 1,
        jitSemanticCorrect: false,
        submittedAnswer: "adv/org-repo-0 / adv/org-repo-1 / adv/org-repo-17",
        oracle: B_ORACLE,
      }),
    );
    expect(metrics.preJitBusinessCallCount).toBe(0);
    expect(metrics.postJitBusinessCallCount).toBe(1);
    expect(metrics.postJitBusinessCalls).toEqual(["github_get_repository"]);
    expect(metrics.fallbackUsed).toBe(true);
    expect(metrics.timelyOffload).toBe(false);
  });

  test("A/C 型：无 pipeline 定义 → preOffloadPipelineCalls / timelyOffload 为 undefined（不做全局阈值）", () => {
    const a = deriveR5Metrics(
      deriveInput({
        taskId: "A",
        toolTimeline: [call("jit_execute_program", 1, true)],
        executeCalls: 1,
        jitSemanticCorrect: undefined,
        submittedAnswer: "1600，TypeScript",
        oracle: [/1[,，]?600/, "TypeScript"],
      }),
    );
    expect(a.offloadDecisionRound).toBe(1);
    expect(a.preJitBusinessCallCount).toBe(0);
    expect(a.preOffloadPipelineCalls).toBeUndefined();
    expect(a.timelyOffload).toBeUndefined();

    const c = deriveR5Metrics(
      deriveInput({
        taskId: "C",
        toolTimeline: [call("jit_execute_program", 2)],
        executeCalls: 1,
        jitSemanticCorrect: true,
        submittedAnswer: "a, b",
        oracle: ["a"],
      }),
    );
    expect(c.preOffloadPipelineCalls).toBeUndefined();
    expect(c.timelyOffload).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// branchFlowSpec —— 分支-汇聚数据流语义检查（R5 review 三轮：不绑定 merge IR shape）
// ---------------------------------------------------------------------------

describe("branchFlowSpec — 只检查“每个分支都真正贡献到最终汇聚”，不绑定 concat/merge 的具体写法", () => {
  const task = R5_TASKS.find((item) => item.id === "B")!;
  const registry = () => new ToolRegistry<RegisteredTool>(task.tools);
  const check = (dsl: string) => {
    const { graph } = compileExecutionDsl(dsl, { tools: registry() });
    return checkTaskCorrectness(graph, task.spec!);
  };
  const HEAD = [
    'repos = github.search_repositories(query="agent framework", limit=30)',
    "details = map(repos, github.get_repository(full_name=_.full_name))",
    'ratio = compute(details, ratio="forks / stars")',
    'high = select(ratio, "ratio > 0.15")',
    'low = select(ratio, "ratio <= 0.15")',
    "high_scores = map(high, github.get_contributor_stats(full_name=_.full_name))",
    "low_scores = map(low, github.list_commits(full_name=_.full_name))",
  ].join("\n");
  const TAIL = ['ranked = sort(good, key="score", desc=true)', "top = take(ranked, 3)", "return top"].join("\n");

  test("PASS 1: concat(high_scores, low_scores) 直接重组（score 记录自带 full_name）", () => {
    const dsl = [HEAD, 'all = concat(high_scores, low_scores)', 'good = select(all, "score >= 100")', TAIL].join("\n");
    expect(check(dsl).pass).toBe(true);
  });

  test("PASS 2: merge_by_key(details, high_scores, low_scores, key=...) 标准实现", () => {
    const dsl = [
      HEAD,
      'good_source = merge_by_key(details, high_scores, low_scores, key="full_name")',
      'good = select(good_source, "score >= 100")',
      TAIL,
    ].join("\n");
    expect(check(dsl).pass).toBe(true);
  });

  test("PASS 3: concat 先拼接再 merge_by_key（串行化等价）", () => {
    const dsl = [
      HEAD,
      'all = concat(high_scores, low_scores)',
      'good_source = merge_by_key(details, all, key="full_name")',
      'good = select(good_source, "score >= 100")',
      TAIL,
    ].join("\n");
    expect(check(dsl).pass).toBe(true);
  });

  test("PASS 4: 串行 merge——先 merge high 再 merge low", () => {
    const dsl = [
      HEAD,
      'm1 = merge_by_key(details, high_scores, key="full_name")',
      'm2 = merge_by_key(m1, low_scores, key="full_name")',
      'good = select(m2, "score >= 100")',
      TAIL,
    ].join("\n");
    expect(check(dsl).pass).toBe(true);
  });

  test("FAIL 5: 只使用 high 分支（low 分支不存在）", () => {
    const dsl = [
      'repos = github.search_repositories(query="agent framework", limit=30)',
      "details = map(repos, github.get_repository(full_name=_.full_name))",
      'ratio = compute(details, ratio="forks / stars")',
      'high = select(ratio, "ratio > 0.15")',
      "high_scores = map(high, github.get_contributor_stats(full_name=_.full_name))",
      'good = select(high_scores, "score >= 100")',
      TAIL,
    ].join("\n");
    expect(check(dsl).pass).toBe(false);
  });

  test("FAIL 6（最关键）: 两个分支都执行，但最终结果只依赖 high → 不能因图里出现过两个工具就算通过", () => {
    // low 分支经 merge 进入 return 闭包（确实"被用到了"），但 score>=100 的汇聚 select 只依赖 high——
    // low 的分数没经过过滤就被并进结果，语义错误。
    const dsl = [
      HEAD,
      'good = select(high_scores, "score >= 100")',
      'merged = merge_by_key(good, low_scores, key="full_name")',
      'ranked = sort(merged, key="score", desc=true)',
      "top = take(ranked, 3)",
      "return top",
    ].join("\n");
    const result = check(dsl);
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("未贡献到最终汇聚"))).toBe(true);
  });

  test("FAIL 7: high 分支错调用 list_commits", () => {
    const dsl = [
      'repos = github.search_repositories(query="agent framework", limit=30)',
      "details = map(repos, github.get_repository(full_name=_.full_name))",
      'ratio = compute(details, ratio="forks / stars")',
      'high = select(ratio, "ratio > 0.15")',
      'low = select(ratio, "ratio <= 0.15")',
      "high_scores = map(high, github.list_commits(full_name=_.full_name))", // 错
      "low_scores = map(low, github.list_commits(full_name=_.full_name))",
      'all = concat(high_scores, low_scores)',
      'good = select(all, "score >= 100")',
      TAIL,
    ].join("\n");
    expect(check(dsl).pass).toBe(false);
  });

  test("FAIL 8: low 分支错调用 get_contributor_stats", () => {
    const dsl = [
      'repos = github.search_repositories(query="agent framework", limit=30)',
      "details = map(repos, github.get_repository(full_name=_.full_name))",
      'ratio = compute(details, ratio="forks / stars")',
      'high = select(ratio, "ratio > 0.15")',
      'low = select(ratio, "ratio <= 0.15")',
      "high_scores = map(high, github.get_contributor_stats(full_name=_.full_name))",
      "low_scores = map(low, github.get_contributor_stats(full_name=_.full_name))", // 错
      'all = concat(high_scores, low_scores)',
      'good = select(all, "score >= 100")',
      TAIL,
    ].join("\n");
    expect(check(dsl).pass).toBe(false);
  });

  test("FAIL 9: 分支谓词错（ratio > 0.20）", () => {
    const dsl = [
      'repos = github.search_repositories(query="agent framework", limit=30)',
      "details = map(repos, github.get_repository(full_name=_.full_name))",
      'ratio = compute(details, ratio="forks / stars")',
      'high = select(ratio, "ratio > 0.20")',
      'low = select(ratio, "ratio <= 0.20")',
      "high_scores = map(high, github.get_contributor_stats(full_name=_.full_name))",
      "low_scores = map(low, github.list_commits(full_name=_.full_name))",
      'all = concat(high_scores, low_scores)',
      'good = select(all, "score >= 100")',
      TAIL,
    ].join("\n");
    expect(check(dsl).pass).toBe(false);
  });

  test("FAIL 10: 汇聚谓词错（score >= 50）", () => {
    const dsl = [
      HEAD,
      'all = concat(high_scores, low_scores)',
      'good = select(all, "score >= 50")',
      TAIL,
    ].join("\n");
    expect(check(dsl).pass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// aggregateR5 —— arm × task 分格汇总
// ---------------------------------------------------------------------------

const baseMetrics = (
  overrides: Partial<R5RunMetrics> & { arm: R5Arm; taskId: R5TaskId },
): R5RunMetrics => ({
  rounds: 3,
  maxedOut: false,
  tokens: { input: 1, output: 1, cacheRead: 0, total: 2 },
  latencyMs: 0,
  toolTimeline: [],
  businessCalls: [],
  describeCalls: 0,
  executeCalls: 0,
  jitAttempted: false,
  jitExecutionSucceeded: false,
  jitSemanticCorrect: undefined,
  jitFinishedWithoutFallback: false,
  fallbackUsed: false,
  preJitBusinessCalls: [],
  preJitBusinessCallCount: 0,
  postJitBusinessCalls: [],
  postJitBusinessCallCount: 0,
  timelyOffload: undefined,
  answerCorrect: true,
  taskCompleted: true,
  finalText: "",
  ...overrides,
});

describe("aggregateR5 — adoption 与 offloadPrecision 分开，按 arm×task 分格", () => {
  test("B 格：adoption（愿意尝试）与 offloadPrecision（正确完成）是不同的数", () => {
    const bGood = baseMetrics({
      arm: "treatment",
      taskId: "B",
      jitAttempted: true,
      jitExecutionSucceeded: true,
      jitSemanticCorrect: true,
      jitFinishedWithoutFallback: true,
      taskCompleted: true,
      lastProgram: {
        source: "…",
        dslCorrect: true,
        compressed: { toolNodes: 2, mapNodes: 2, fanoutSum: 34, computeNodes: 5, mergeNodes: 1, concatNodes: 0, returnNodes: 1, atomicOps: 43 },
        correctlyCompressedOps: 43,
      },
    });
    const bBad = baseMetrics({
      arm: "treatment",
      taskId: "B",
      jitAttempted: true,
      jitExecutionSucceeded: true,
      jitSemanticCorrect: false,
      maxedOut: true,
      answerCorrect: false,
      taskCompleted: false,
    });
    const agg = aggregateR5([bGood, bBad], "treatment", "B");
    expect(agg.runs).toBe(2);
    expect(agg.adoptionRate).toBe(1); // 都愿意尝试
    expect(agg.jitExecutionSucceededRate).toBe(1);
    expect(agg.jitSemanticCorrectRate).toBe(0.5);
    expect(agg.jitFinishedWithoutFallbackRate).toBe(0.5);
    expect(agg.offloadPrecision).toBe(0.5); // 语义正确 1 / 尝试 2
    expect(agg.taskCompletionRate).toBe(0.5);
    expect(agg.maxedOutRate).toBe(0.5);
    expect(agg.fallbackRate).toBe(0);
    expect(agg.avgCompressedOps).toBe(43);
    expect(agg.avgCorrectlyCompressedOps).toBe(43); // 只统计语义正确程序
    expect(agg.unnecessaryOffloadRate).toBeUndefined(); // B 格无此概念
  });

  test("B 格 offloadPrecision：分母是尝试过的 run（attempted），不是总 run 数", () => {
    const good = baseMetrics({
      arm: "treatment",
      taskId: "B",
      jitAttempted: true,
      jitExecutionSucceeded: true,
      jitSemanticCorrect: true,
      jitFinishedWithoutFallback: true,
      taskCompleted: true,
    });
    const bad = baseMetrics({
      arm: "treatment",
      taskId: "B",
      jitAttempted: true,
      jitExecutionSucceeded: true,
      jitSemanticCorrect: false,
      answerCorrect: false,
      taskCompleted: false,
    });
    const neverTried = baseMetrics({ arm: "treatment", taskId: "B" });
    const agg = aggregateR5([good, bad, neverTried], "treatment", "B");
    expect(agg.adoptionRate).toBeCloseTo(2 / 3); // 3 个里 2 个尝试
    expect(agg.offloadPrecision).toBe(0.5); // 语义正确 1 / 尝试 2（旧定义会是 1/3≈0.33）
  });

  test("A 格：unnecessaryOffloadRate = jitAttempted 比例", () => {
    const aPlain = baseMetrics({ arm: "treatment", taskId: "A" });
    const aJit = baseMetrics({
      arm: "treatment",
      taskId: "A",
      jitAttempted: true,
      jitExecutionSucceeded: true,
      jitSemanticCorrect: undefined, // A 无 spec，语义不可判定
    });
    const agg = aggregateR5([aPlain, aJit], "treatment", "A");
    expect(agg.adoptionRate).toBe(0.5);
    expect(agg.unnecessaryOffloadRate).toBe(0.5); // A 上尝试 JIT 即多余
    expect(agg.offloadPrecision).toBe(0); // semanticCorrect===true 才计，A 上无 spec → 0
  });

  test("control 臂与 treatment 臂互不混用", () => {
    const control = baseMetrics({ arm: "control", taskId: "A" });
    const treatment = baseMetrics({ arm: "treatment", taskId: "A" });
    expect(aggregateR5([control, treatment], "control", "A").runs).toBe(1);
    expect(aggregateR5([control, treatment], "treatment", "A").runs).toBe(1);
    expect(buildR5Aggregates([control, treatment]).control.A.runs).toBe(1);
    expect(buildR5Aggregates([control, treatment]).treatment.A.runs).toBe(1);
  });
});

describe("writeR5Report — 结果记录到 log（report.json，含完整 tool timeline 与分格汇总）", () => {
  test("写入配置 + 任务元数据 + 全部 runs + arm×task 汇总，JSON 可读回", () => {
    const runs: R5RunMetrics[] = [
      baseMetrics({
        arm: "control",
        taskId: "A",
        rounds: 2,
        tokens: { input: 100, output: 50, cacheRead: 0, total: 150 },
        latencyMs: 2000,
        toolTimeline: [
          call("github_get_repository"),
          call("submit_answer"),
        ],
        businessCalls: ["github_get_repository"],
        submittedAnswer: "1600, TypeScript",
        finalText: "…",
      }),
      baseMetrics({
        arm: "treatment",
        taskId: "B",
        rounds: 4,
        tokens: { input: 1000, output: 500, cacheRead: 0, total: 1500 },
        latencyMs: 15000,
        toolTimeline: [
          call("jit_describe_tools"),
          call("jit_execute_program"),
        ],
        businessCalls: [],
        describeCalls: 1,
        executeCalls: 1,
        jitAttempted: true,
        jitExecutionSucceeded: true,
        jitSemanticCorrect: false,
        answerCorrect: false,
        taskCompleted: false,
        lastProgram: {
          source: 'repos = github.search_repositories(query="agent framework", limit=30)',
          dslCorrect: false,
          compressed: { toolNodes: 2, mapNodes: 2, fanoutSum: 34, computeNodes: 5, mergeNodes: 1, concatNodes: 0, returnNodes: 1, atomicOps: 43 },
        },
      }),
    ];
    const aggregates = buildR5Aggregates(runs);

    const outDir = path.join(os.tmpdir(), `r5-report-test-${Date.now()}`);
    const reportPath = writeR5Report(outDir, { arm: "both", task: "all", samples: 1, rounds: 10, dslGuidance: "patterns" }, R5_TASKS, runs, aggregates);
    try {
      expect(fs.existsSync(reportPath)).toBe(true);
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
        mode: string;
        config: { arm: string; task: string; samples: number; rounds: number; dslGuidance?: string };
        tasks: Array<{ id: string; name: string; prompt: string; oracle: string[] }>;
        aggregates: Record<string, Record<string, { runs: number; adoptionRate: number }>>;
        runs: Array<{
          arm: string;
          taskId: string;
          jitAttempted: boolean;
          jitSemanticCorrect: boolean | null;
          taskCompleted: boolean;
          toolTimeline: Array<{ name: string; isError: boolean }>;
        }>;
      };
      expect(report.mode).toBe("r5-autonomous-offloading");
      expect(report.config).toEqual({ arm: "both", task: "all", samples: 1, rounds: 10, dslGuidance: "patterns" });
      expect(report.tasks.map((task) => task.id)).toEqual(["A", "B", "C"]);
      // 每个任务都记录了 prompt 与 oracle（RegExp 已序列化为字符串）
      for (const task of report.tasks) {
        expect(task.prompt.length).toBeGreaterThan(0);
        expect(task.oracle.length).toBeGreaterThan(0);
      }
      // arm×task 分格汇总
      expect(report.aggregates.control.A.runs).toBe(1);
      expect(report.aggregates.treatment.B.runs).toBe(1);
      expect(report.aggregates.treatment.B.adoptionRate).toBe(1);
      expect(report.runs).toHaveLength(2);
      // run 级：完整 tool timeline + 拆分指标
      expect(report.runs[1].toolTimeline).toEqual([
        call("jit_describe_tools"),
        call("jit_execute_program"),
      ]);
      expect(report.runs[1].jitAttempted).toBe(true);
      expect(report.runs[1].jitSemanticCorrect).toBe(false);
      expect(report.runs[1].taskCompleted).toBe(false);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe("parseFlags — --dsl-guidance（Z/P/F ablation）", () => {
  test("默认 patterns（产品候选）", () => {
    expect(parseFlags([]).dslGuidance).toBe("patterns");
  });

  test("解析 primitive / patterns / full-example", () => {
    expect(parseFlags(["--dsl-guidance=primitive"]).dslGuidance).toBe("primitive");
    expect(parseFlags(["--dsl-guidance=patterns"]).dslGuidance).toBe("patterns");
    expect(parseFlags(["--dsl-guidance=full-example"]).dslGuidance).toBe("full-example");
  });

  test("非法值报错", () => {
    expect(() => parseFlags(["--dsl-guidance=foo"])).toThrow(/dsl-guidance/);
  });

  test("与其他 flag 共存解析", () => {
    const flags = parseFlags(["--arm=treatment", "--task=B", "--samples=10", "--dsl-guidance=primitive"]);
    expect(flags).toMatchObject({ arm: "treatment", task: "B", samples: 10, dslGuidance: "primitive" });
  });
});
