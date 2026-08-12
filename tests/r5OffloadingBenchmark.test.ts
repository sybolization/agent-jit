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
  buildR5JitGroups,
  createR5SubmitTool,
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
          call("github_get_repository", 2), // fallback 补救（execute 之后的轮次）
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
          call("github_get_repository", 2),
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
          call("github_get_repository", 2),
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
    expect(metrics.preOffloadBusinessCallCount).toBe(0);
    expect(metrics.postExecuteBusinessCallCount).toBe(0);
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
    expect(metrics.preOffloadBusinessCallCount).toBe(31);
    expect(metrics.preOffloadPipelineCalls).toBe(31); // 最贵的 iterative 部分已被普通工具做完
    expect(metrics.timelyOffload).toBe(false); // 但 offload boundary 太晚，不是及时 offload
  });

  test("看到 execute 结果后仍有业务调用 → pre/post-execute 分界正确，且这些不算 timely（语义错时）", () => {
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
    expect(metrics.preOffloadBusinessCallCount).toBe(0);
    expect(metrics.postExecuteBusinessCallCount).toBe(1);
    expect(metrics.postExecuteBusinessCalls).toEqual(["github_get_repository"]);
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
    expect(a.preOffloadBusinessCallCount).toBe(0);
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

  test("同轮并发不判 fallback：describe 与业务工具同一轮发出 → sameRound 桶，fallbackUsed=false", () => {
    const metrics = deriveR5Metrics(
      deriveInput({
        taskId: "B",
        toolTimeline: [
          call("jit_describe_tools", 1),
          call("github_search_repositories", 1), // 与 describe 同一轮并发发出
          call("jit_execute_program", 2),
          call("submit_answer", 3),
        ],
        businessCalls: ["github_search_repositories"],
        describeCalls: 1,
        executeCalls: 1,
        jitSemanticCorrect: true,
        submittedAnswer: "adv/org-repo-0 / adv/org-repo-1 / adv/org-repo-17",
        oracle: B_ORACLE,
      }),
    );
    expect(metrics.fallbackUsed).toBe(false);
    expect(metrics.sameRoundBusinessCalls).toEqual(["github_search_repositories"]);
    expect(metrics.preOffloadBusinessCallCount).toBe(0);
    expect(metrics.postExecuteBusinessCallCount).toBe(0);
    expect(metrics.preOffloadPipelineCalls).toBe(0); // 同轮 search 不入 pre（round-strict）
    expect(metrics.timelyOffload).toBe(true);
  });

  test("看到 execute 结果后才判 fallback：round > lastExecuteRound 的业务调用才进 postExecute 桶", () => {
    const metrics = deriveR5Metrics(
      deriveInput({
        taskId: "B",
        toolTimeline: [
          call("jit_describe_tools", 1),
          call("jit_execute_program", 2),
          call("github_get_repository", 3), // 已看到 execute 结果后的补救
        ],
        businessCalls: ["github_get_repository"],
        describeCalls: 1,
        executeCalls: 1,
        jitSemanticCorrect: true,
        submittedAnswer: "adv/org-repo-0 / adv/org-repo-1 / adv/org-repo-17",
        oracle: B_ORACLE,
      }),
    );
    expect(metrics.fallbackUsed).toBe(true);
    expect(metrics.postExecuteBusinessCalls).toEqual(["github_get_repository"]);
    expect(metrics.sameRoundBusinessCalls).toEqual([]);
    expect(metrics.preOffloadBusinessCallCount).toBe(0);
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
  preOffloadBusinessCalls: [],
  preOffloadBusinessCallCount: 0,
  sameRoundBusinessCalls: [],
  sameRoundBusinessCallCount: 0,
  postExecuteBusinessCalls: [],
  postExecuteBusinessCallCount: 0,
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
  test("默认 primitive（production default）", () => {
    expect(parseFlags([]).dslGuidance).toBe("primitive");
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

describe("aggregateR5 — 分项 token 均值", () => {
  test("avgUncachedInput / avgCacheRead / avgOutput / avgTokens 分别统计", () => {
    const runA = baseMetrics({ arm: "treatment", taskId: "B", tokens: { input: 100, output: 50, cacheRead: 200, total: 350 } });
    const runB = baseMetrics({ arm: "treatment", taskId: "B", tokens: { input: 300, output: 150, cacheRead: 400, total: 850 } });
    const agg = aggregateR5([runA, runB], "treatment", "B");
    expect(agg.avgUncachedInputTokens).toBe(200);
    expect(agg.avgCacheReadTokens).toBe(300);
    expect(agg.avgOutputTokens).toBe(100);
    expect(agg.avgTokens).toBe(600);
  });
});

describe("buildR5JitGroups — clean / earlyDirty / late / noJit 不重不漏", () => {
  test("三种边界 case 分到正确组，count 之和等于格内总数", () => {
    const clean = baseMetrics({
      arm: "treatment", taskId: "B",
      jitAttempted: true, jitSemanticCorrect: true, jitFinishedWithoutFallback: true,
      timelyOffload: true, tokens: { input: 10, output: 10, cacheRead: 0, total: 20 }, rounds: 3,
    });
    const dirtySemanticWrong = baseMetrics({
      arm: "treatment", taskId: "B",
      jitAttempted: true, jitSemanticCorrect: false, jitFinishedWithoutFallback: false,
      timelyOffload: false, tokens: { input: 100, output: 100, cacheRead: 0, total: 200 }, rounds: 8,
    });
    const dirtyFallback = baseMetrics({
      arm: "treatment", taskId: "B",
      jitAttempted: true, jitSemanticCorrect: true, jitFinishedWithoutFallback: false, fallbackUsed: true,
      timelyOffload: false, tokens: { input: 50, output: 50, cacheRead: 0, total: 100 }, rounds: 6,
    });
    const noJit = baseMetrics({
      arm: "treatment", taskId: "B", jitAttempted: false,
      tokens: { input: 30, output: 30, cacheRead: 0, total: 60 }, rounds: 2,
    });
    const groups = buildR5JitGroups([clean, dirtySemanticWrong, dirtyFallback, noJit], "treatment", "B");
    const byGroup = Object.fromEntries(groups.map((g) => [g.group, g])) as Record<string, (typeof groups)[number]>;
    expect(groups.reduce((s, g) => s + g.runs, 0)).toBe(4);
    expect(byGroup.cleanOffload.runs).toBe(1);
    expect(byGroup.earlyDirtyOffload.runs).toBe(2); // 语义错 + fallback（老字段缺失时归早脏）
    expect(byGroup.lateOffload.runs).toBe(0);
    expect(byGroup.noJit.runs).toBe(1);
    expect(byGroup.cleanOffload.avgTokens).toBe(20);
    expect(byGroup.earlyDirtyOffload.avgTokens).toBe(150); // (200 + 100) / 2
    expect(byGroup.noJit.avgTokens).toBe(60);
  });

  test("lateOffload：earlyOffloadDecision === false（决策晚）单独成组", () => {
    const late = baseMetrics({
      arm: "treatment", taskId: "B",
      jitAttempted: true, jitSemanticCorrect: true, jitFinishedWithoutFallback: true,
      timelyOffload: false, earlyOffloadDecision: false, preExecutePipelineCalls: 3,
      tokens: { input: 10, output: 10, cacheRead: 0, total: 20 }, rounds: 7,
    });
    const groups = buildR5JitGroups([late], "treatment", "B");
    const byGroup = Object.fromEntries(groups.map((g) => [g.group, g])) as Record<string, (typeof groups)[number]>;
    expect(byGroup.lateOffload.runs).toBe(1);
    expect(byGroup.cleanOffload.runs).toBe(0);
    expect(byGroup.earlyDirtyOffload.runs).toBe(0);
  });

  test("严格 clean：同轮 pipeline 重复（preExecutePipelineCalls > 0）→ earlyDirtyOffload", () => {
    const dirty = baseMetrics({
      arm: "treatment", taskId: "B",
      jitAttempted: true, jitSemanticCorrect: true, jitFinishedWithoutFallback: true,
      timelyOffload: true, earlyOffloadDecision: true, preExecutePipelineCalls: 1,
      tokens: { input: 10, output: 10, cacheRead: 0, total: 20 }, rounds: 4,
    });
    const groups = buildR5JitGroups([dirty], "treatment", "B");
    const byGroup = Object.fromEntries(groups.map((g) => [g.group, g])) as Record<string, (typeof groups)[number]>;
    expect(byGroup.earlyDirtyOffload.runs).toBe(1); // 决策早但执行不干净
    expect(byGroup.cleanOffload.runs).toBe(0);
  });

  test("A 型 clean：jitFinishedWithoutFallback 且 timelyOffload 非 false → clean", () => {
    const a = baseMetrics({
      arm: "treatment", taskId: "A",
      jitAttempted: true, jitSemanticCorrect: true, jitFinishedWithoutFallback: true,
      timelyOffload: undefined, tokens: { input: 1, output: 1, cacheRead: 0, total: 2 }, rounds: 4,
    });
    const groups = buildR5JitGroups([a], "treatment", "A");
    expect(groups.find((g) => g.group === "cleanOffload")!.runs).toBe(1);
    expect(groups.find((g) => g.group === "noJit")!.runs).toBe(0);
  });
});

describe("writeR5Report — tokenRounds 与 jitGroups", () => {
  test("新 run 写入 tokenRounds；顶层输出 jitGroups；无 tokenRounds 的 run 不写该字段", () => {
    const runs: R5RunMetrics[] = [
      baseMetrics({
        arm: "treatment", taskId: "B",
        jitAttempted: true, jitSemanticCorrect: true, jitFinishedWithoutFallback: true,
        timelyOffload: true, tokens: { input: 100, output: 50, cacheRead: 0, total: 150 },
        tokenRounds: [
          { round: 1, input: 100, cacheRead: 0, output: 30, total: 130, toolCalls: ["jit_describe_tools"] },
          { round: 2, input: 0, cacheRead: 100, output: 20, total: 120, toolCalls: ["jit_execute_program"] },
        ],
      }),
      baseMetrics({ arm: "control", taskId: "B", tokens: { input: 200, output: 100, cacheRead: 0, total: 300 } }),
    ];
    const outDir = path.join(os.tmpdir(), `r5-token-report-${Date.now()}`);
    const reportPath = writeR5Report(outDir, { arm: "both", task: "B", samples: 1, rounds: 10 }, R5_TASKS, runs, buildR5Aggregates(runs));
    try {
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
        runs: Array<{ tokenRounds?: Array<{ round: number; input: number; total: number; toolCalls: string[] }> }>;
        jitGroups: Record<string, Record<string, Array<{ group: string; runs: number; avgTokens: number }>>>;
      };
      expect(report.runs[0]!.tokenRounds).toHaveLength(2);
      expect(report.runs[0]!.tokenRounds![0]).toMatchObject({ round: 1, input: 100, toolCalls: ["jit_describe_tools"] });
      expect(report.runs[1]!.tokenRounds).toBeUndefined();
      expect(report.jitGroups.treatment.B).toHaveLength(4); // clean / earlyDirty / late / noJit
      expect(report.jitGroups.treatment.B.reduce((s, g) => s + g.runs, 0)).toBe(1);
      expect(report.jitGroups.treatment.B.find((g) => g.group === "cleanOffload")!.runs).toBe(1);
      expect(report.jitGroups.control.B.reduce((s, g) => s + g.runs, 0)).toBe(1);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe("stopAfterSubmit — createR5SubmitTool / parseFlags / report config", () => {
  test("createR5SubmitTool(true) 的 execute 结果含 terminate:true；false 不含", async () => {
    const withStop = await createR5SubmitTool(true).execute("id", { answer: "x" });
    expect(withStop.terminate).toBe(true);
    const withoutStop = await createR5SubmitTool(false).execute("id", { answer: "x" });
    expect(withoutStop.terminate).toBeUndefined();
  });

  test("parseFlags：--stop-after-submit → true；默认 false", () => {
    expect(parseFlags([]).stopAfterSubmit).toBe(false);
    expect(parseFlags(["--stop-after-submit"]).stopAfterSubmit).toBe(true);
  });

  test("writeR5Report：config 记录 stopAfterSubmit", () => {
    const runs: R5RunMetrics[] = [baseMetrics({ arm: "control", taskId: "B" })];
    const outDir = path.join(os.tmpdir(), `r5-stop-report-${Date.now()}`);
    const reportPath = writeR5Report(
      outDir,
      { arm: "control", task: "B", samples: 1, rounds: 10, stopAfterSubmit: true },
      R5_TASKS,
      runs,
      buildR5Aggregates(runs),
    );
    try {
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as { config: { stopAfterSubmit?: boolean } };
      expect(report.config.stopAfterSubmit).toBe(true);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe("deriveR5Metrics — 新 pipeline 指标（sameRound / preExecute / early / duplicated）", () => {
  test("describe + search 同轮：sameRoundPipelineCallCount=1、preExecutePipelineCalls=1、earlyOffloadDecision=true", () => {
    const metrics = deriveR5Metrics(
      deriveInput({
        taskId: "B",
        toolTimeline: [
          call("github_search_repositories", 1),
          call("jit_describe_tools", 1),
          call("jit_execute_program", 2),
          call("submit_answer", 3),
        ],
        businessCalls: ["github_search_repositories"],
        describeCalls: 1,
        executeCalls: 1,
        jitSemanticCorrect: true,
        submittedAnswer: "adv/org-repo-0",
        oracle: ["adv/org-repo-0"],
      }),
    );
    expect(metrics.preOffloadPipelineCalls).toBe(0); // round < firstJitRound 无 pipeline
    expect(metrics.sameRoundPipelineCallCount).toBe(1); // 同轮 search 被识别为 pipeline call
    expect(metrics.preExecutePipelineCalls).toBe(1);
    expect(metrics.earlyOffloadDecision).toBe(true); // 决策早（纯时间维度）
    expect(metrics.timelyOffload).toBe(true); // 旧定义保留（deprecated）
  });

  test("duplicatedPipelineCalls：host 已 search，JIT source 又 search → 1", () => {
    const metrics = deriveR5Metrics(
      deriveInput({
        taskId: "B",
        toolTimeline: [
          call("github_search_repositories", 1),
          call("jit_describe_tools", 2),
          call("jit_execute_program", 3),
        ],
        businessCalls: ["github_search_repositories"],
        describeCalls: 1,
        executeCalls: 1,
        jitSemanticCorrect: true,
        lastProgramSource: 'repos = github.search_repositories(query="agent framework", limit=30)',
        submittedAnswer: "adv/org-repo-0",
        oracle: ["adv/org-repo-0"],
      }),
    );
    expect(metrics.duplicatedPipelineCalls).toBe(1); // search 在 JIT 内重复
  });

  test("duplicatedPipelineCalls：host 未执行过 pipeline → 0", () => {
    const metrics = deriveR5Metrics(
      deriveInput({
        taskId: "B",
        toolTimeline: [call("jit_execute_program", 1)],
        executeCalls: 1,
        jitSemanticCorrect: true,
        lastProgramSource: 'repos = github.search_repositories(query="agent framework", limit=30)',
        submittedAnswer: "adv/org-repo-0",
        oracle: ["adv/org-repo-0"],
      }),
    );
    expect(metrics.duplicatedPipelineCalls).toBe(0);
  });
});

describe("aggregateR5 — 新 pipeline 汇总字段", () => {
  test("avgSameRoundPipelineCalls / avgPreExecutePipelineCalls / earlyOffloadDecisionRate", () => {
    const runA = baseMetrics({
      arm: "treatment", taskId: "B",
      jitAttempted: true, jitSemanticCorrect: true, jitFinishedWithoutFallback: true,
      earlyOffloadDecision: true, preExecutePipelineCalls: 0, sameRoundPipelineCallCount: 0,
    });
    const runB = baseMetrics({
      arm: "treatment", taskId: "B",
      jitAttempted: true, jitSemanticCorrect: false, jitFinishedWithoutFallback: false,
      earlyOffloadDecision: false, preExecutePipelineCalls: 3, sameRoundPipelineCallCount: 1,
    });
    const agg = aggregateR5([runA, runB], "treatment", "B");
    expect(agg.avgSameRoundPipelineCalls).toBe(0.5);
    expect(agg.avgPreExecutePipelineCalls).toBe(1.5);
    expect(agg.earlyOffloadDecisionRate).toBe(0.5);
    expect(agg.avgPreOffloadPipelineCalls).toBeUndefined(); // 未设置 preOffload 值
  });
});

describe("boundaryPolicy — r5TreatmentSystemPrompt 开关", () => {
  test("默认不追加 Offload 边界策略（保持旧极简提示词）", () => {
    const prompt = r5TreatmentSystemPrompt();
    expect(prompt).not.toContain("Offload 边界策略");
    expect(prompt).not.toContain("边界策略");
  });

  test("boundaryPolicy:true 追加编号规则，仍保留 jit_* 工具说明", () => {
    const prompt = r5TreatmentSystemPrompt({ boundaryPolicy: true });
    expect(prompt).toContain("## Offload 边界策略");
    expect(prompt).toContain("决策规则");
    expect(prompt).toContain("同一个 assistant turn");
    expect(prompt).toMatch(/1\. /);
    expect(prompt).toMatch(/2\. /);
    expect(prompt).toContain("jit_describe_tools");
    expect(prompt).toContain("jit_execute_program");
    expect(prompt).toContain("submit_answer");
  });
});

describe("boundaryPolicy — parseFlags", () => {
  test("--boundary-policy → true；默认 false", () => {
    expect(parseFlags([]).boundaryPolicy).toBe(false);
    expect(parseFlags(["--boundary-policy"]).boundaryPolicy).toBe(true);
  });

  test("与 --stop-after-submit 共存解析", () => {
    const flags = parseFlags(["--stop-after-submit", "--boundary-policy"]);
    expect(flags.stopAfterSubmit).toBe(true);
    expect(flags.boundaryPolicy).toBe(true);
  });
});

describe("boundaryPolicy — writeR5Report config", () => {
  test("writeR5Report：config 记录 boundaryPolicy", () => {
    const runs: R5RunMetrics[] = [baseMetrics({ arm: "treatment", taskId: "B" })];
    const outDir = path.join(os.tmpdir(), `r5-boundary-report-${Date.now()}`);
    const reportPath = writeR5Report(
      outDir,
      { arm: "treatment", task: "B", samples: 1, rounds: 10, boundaryPolicy: true },
      R5_TASKS,
      runs,
      buildR5Aggregates(runs),
    );
    try {
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as { config: { boundaryPolicy?: boolean } };
      expect(report.config.boundaryPolicy).toBe(true);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("writeR5Report：未传 boundaryPolicy 时 config 不写该字段", () => {
    const runs: R5RunMetrics[] = [baseMetrics({ arm: "treatment", taskId: "B" })];
    const outDir = path.join(os.tmpdir(), `r5-boundary-report-none-${Date.now()}`);
    const reportPath = writeR5Report(
      outDir,
      { arm: "treatment", task: "B", samples: 1, rounds: 10 },
      R5_TASKS,
      runs,
      buildR5Aggregates(runs),
    );
    try {
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as { config: { boundaryPolicy?: boolean } };
      expect(report.config.boundaryPolicy).toBeUndefined();
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe("aggregateR5 — 四组占比与 avgDuplicatedPipelineCalls（Primary Metric）", () => {
  test("clean / earlyDirty / late / noJit 不重不漏，占比之和为 1", () => {
    const clean = baseMetrics({
      arm: "treatment", taskId: "B",
      jitAttempted: true, jitSemanticCorrect: true, jitFinishedWithoutFallback: true,
      timelyOffload: true, earlyOffloadDecision: true,
    });
    const earlyDirty1 = baseMetrics({
      arm: "treatment", taskId: "B",
      jitAttempted: true, jitSemanticCorrect: true, jitFinishedWithoutFallback: true,
      earlyOffloadDecision: true, preExecutePipelineCalls: 1, duplicatedPipelineCalls: 2,
    });
    const earlyDirty2 = baseMetrics({
      arm: "treatment", taskId: "B",
      jitAttempted: true, jitSemanticCorrect: false, jitFinishedWithoutFallback: false,
      earlyOffloadDecision: true, duplicatedPipelineCalls: undefined,
    });
    const late = baseMetrics({
      arm: "treatment", taskId: "B",
      jitAttempted: true, jitSemanticCorrect: true, jitFinishedWithoutFallback: true,
      earlyOffloadDecision: false, preExecutePipelineCalls: 3,
    });
    const noJit = baseMetrics({ arm: "treatment", taskId: "B", jitAttempted: false });

    const agg = aggregateR5([clean, earlyDirty1, earlyDirty2, late, noJit], "treatment", "B");
    expect(agg.runs).toBe(5);
    expect(agg.cleanOffloadRate).toBeCloseTo(1 / 5, 10);
    expect(agg.earlyDirtyOffloadRate).toBeCloseTo(2 / 5, 10);
    expect(agg.lateOffloadRate).toBeCloseTo(1 / 5, 10);
    expect(agg.noJitRate).toBeCloseTo(1 / 5, 10);
    expect(agg.cleanOffloadRate + agg.earlyDirtyOffloadRate + agg.lateOffloadRate + agg.noJitRate).toBeCloseTo(1, 10);
    expect(agg.avgDuplicatedPipelineCalls).toBe(2); // 只有 earlyDirty1 有定义值（earlyDirty2 为 undefined 被过滤）
    expect(agg.adoptionRate).toBeCloseTo(4 / 5, 10); // 4/5 尝试过 JIT，无回归
  });
});

describe("deriveR5Metrics — R6.1 新指标（firstPassCompile / repairRounds / repairTokens / describeFallback）", () => {
  test("首次编译即通过：firstPassCompileSuccess=true、repairRounds=0、compileAttempts=1、无 describe 兜底、repairTokens 无定义", () => {
    const metrics = deriveR5Metrics(
      deriveInput({
        taskId: "B",
        rounds: 2,
        toolTimeline: [
          call("jit_execute_program", 1),
          call("submit_answer", 2),
        ],
        executeCalls: 1,
        tokenRounds: [
          { round: 1, input: 1, cacheRead: 0, output: 1, total: 2, toolCalls: ["jit_execute_program"] },
          { round: 2, input: 1, cacheRead: 0, output: 1, total: 2, toolCalls: ["submit_answer"] },
        ],
        jitSemanticCorrect: true,
        submittedAnswer: "adv/org-repo-0",
        oracle: ["adv/org-repo-0"],
      }),
    );
    expect(metrics.firstPassCompileSuccess).toBe(true);
    expect(metrics.repairRounds).toBe(0);
    expect(metrics.compileAttempts).toBe(1);
    expect(metrics.describeFallbackUsed).toBe(false);
    expect(metrics.repairTokens).toBeUndefined(); // 无失败轮 → repair 区间不存在
  });

  test("先失败后成功：repairRounds=1、repairTokens = 失败轮到成功轮区间内各轮 total 之和", () => {
    const metrics = deriveR5Metrics(
      deriveInput({
        taskId: "B",
        rounds: 3,
        toolTimeline: [
          call("jit_execute_program", 1, true),
          call("jit_execute_program", 2),
          call("submit_answer", 3),
        ],
        executeCalls: 2,
        tokenRounds: [
          { round: 1, input: 100, cacheRead: 0, output: 100, total: 200, toolCalls: ["jit_execute_program"] },
          { round: 2, input: 100, cacheRead: 100, output: 100, total: 300, toolCalls: ["jit_execute_program"] },
          { round: 3, input: 50, cacheRead: 200, output: 50, total: 300, toolCalls: ["submit_answer"] },
        ],
        jitSemanticCorrect: true,
        submittedAnswer: "adv/org-repo-0",
        oracle: ["adv/org-repo-0"],
      }),
    );
    expect(metrics.firstPassCompileSuccess).toBe(false);
    expect(metrics.repairRounds).toBe(1);
    expect(metrics.repairTokens).toBe(500); // 区间 [1, 2]：round 1（200）+ round 2（300）
  });

  test("从未 execute：firstPassCompileSuccess / repairRounds / repairTokens 无定义，compileAttempts=0", () => {
    const metrics = deriveR5Metrics(
      deriveInput({
        taskId: "B",
        toolTimeline: [call("submit_answer", 1)],
        executeCalls: 0,
      }),
    );
    expect(metrics.firstPassCompileSuccess).toBeUndefined();
    expect(metrics.repairRounds).toBeUndefined();
    expect(metrics.compileAttempts).toBe(0);
  });

  test("aggregateR5：firstPassCompileRate / avgRepairRounds / describeFallbackRate / avgRepairTokens / eventualCompileRate", () => {
    const runOk = baseMetrics({
      arm: "treatment", taskId: "B",
      contractMode: "compile-first",
      jitAttempted: true,
      jitExecutionSucceeded: true,
      firstPassCompileSuccess: true,
      repairRounds: 0,
      describeFallbackUsed: false,
    });
    const runRepaired = baseMetrics({
      arm: "treatment", taskId: "B",
      contractMode: "compile-first",
      jitAttempted: true,
      jitExecutionSucceeded: false,
      firstPassCompileSuccess: false,
      repairRounds: 2,
      describeFallbackUsed: true,
      repairTokens: 300,
    });
    const agg = aggregateR5([runOk, runRepaired], "treatment", "B");
    expect(agg.firstPassCompileRate).toBe(0.5);
    expect(agg.avgRepairRounds).toBe(1);
    expect(agg.describeFallbackRate).toBe(0.5);
    expect(agg.avgRepairTokens).toBe(300);
    expect(agg.eventualCompileRate).toBe(agg.jitExecutionSucceededRate); // 语义别名
    expect(agg.eventualCompileRate).toBe(0.5);
  });
});

describe("r5TreatmentSystemPrompt — contractMode 三臂", () => {
  test("默认 = eager-describe：与显式传入输出逐字节相同，无 Output manifest / DSL 参考", () => {
    const defaultPrompt = r5TreatmentSystemPrompt();
    const eagerPrompt = r5TreatmentSystemPrompt({ contractMode: "eager-describe" });
    expect(eagerPrompt).toBe(defaultPrompt);
    expect(defaultPrompt).not.toContain("Output manifest");
    expect(defaultPrompt).not.toContain("## 1. Tool calls");
  });

  test("compile-first：直接 execute + 结构化诊断兜底，无“先 describe”约束，追加 DSL 参考", () => {
    const prompt = r5TreatmentSystemPrompt({ contractMode: "compile-first" });
    expect(prompt).toContain("jit_execute_program");
    expect(prompt).toContain("结构化诊断");
    expect(prompt).not.toContain("需要时先用");
    expect(prompt).toContain("## Agent Execution DSL 参考");
    expect(prompt).toContain("## 1. Tool calls");
  });

  test("compact-manifest：追加 ## Output manifest 与 manifest 行（仍无“先 describe”约束）", () => {
    const prompt = r5TreatmentSystemPrompt({
      contractMode: "compact-manifest",
      manifest: "github.search_repositories -> [{full_name}]",
    });
    expect(prompt).toContain("## Output manifest");
    expect(prompt).toContain("github.search_repositories -> [{full_name}]");
    expect(prompt).toContain("结构化诊断");
    expect(prompt).not.toContain("需要时先用");
  });
});
