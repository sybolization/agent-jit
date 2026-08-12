import { describe, expect, test } from "vitest";

import { rescoreRun, type StoredRun } from "../src/experiments/rescoreR5Report.js";
import { R5_TASKS } from "../src/experiments/r5Tasks.js";
import { buildR6Cells, type R6ReportConfig } from "../src/experiments/r6DescribeBenchmark.js";
import type { R5RunMetrics, R6ContractMode } from "../src/experiments/r5OffloadingBenchmark.js";

const taskB = R5_TASKS.find((task) => task.id === "B")!;

/** 规范 B DSL（与 tests/r5Tasks.test.ts 的 B_DSL 同款）：search 30 → details → ratio 分支 → 两路 map 得分 → merge → score 过滤 → 排序 → 取 3 → return。 */
const B_DSL = [
  'repos = github.search_repositories(query="agent framework", limit=30)',
  "details = map(repos, github.get_repository(full_name=_.full_name))",
  'ratio = compute(details, ratio="forks / stars")',
  'contrib = select(ratio, "ratio > 0.15")',
  'commit = select(ratio, "ratio <= 0.15")',
  "contribs = map(contrib, github.get_contributor_stats(full_name=_.full_name))",
  "commits = map(commit, github.list_commits(full_name=_.full_name))",
  'merged = merge_by_key(details, contribs, commits, key="full_name")',
  'kept = select(merged, "score >= 100")',
  'ranked = sort(kept, key="score", desc=true)',
  "top = take(ranked, 3)",
  "return top",
].join("\n");

const compressed = {
  toolNodes: 1,
  mapNodes: 3,
  fanoutSum: 60,
  computeNodes: 6,
  mergeNodes: 0,
  concatNodes: 1,
  returnNodes: 1,
  atomicOps: 69,
};

/** 存储形态 run 的最小构造（默认：treatment/B/有规范 B 程序且旧判分正确）。 */
const baseRun = (overrides: Partial<StoredRun>): StoredRun => ({
  arm: "treatment",
  taskId: "B",
  rounds: 3,
  maxedOut: false,
  tokens: { input: 100, output: 50, cacheRead: 0, total: 150 },
  latencyMs: 0,
  toolTimeline: [],
  businessCalls: [],
  describeCalls: 0,
  executeCalls: 1,
  jitSemanticCorrect: true,
  executeErrors: [],
  submittedAnswer: "adv/org-repo-0\nadv/org-repo-1\nadv/org-repo-17",
  finalText: "",
  taskCompleted: true,
  lastProgram: { source: B_DSL, dslCorrect: true, compressed },
  ...overrides,
});

describe("rescoreRun — 执行级语义重判（checkTaskSemantics）", () => {
  test("无 return 的 source 重新编译失败 → jitSemanticCorrect=false 且 compileFailed 含 missing_return", async () => {
    const run = baseRun({
      jitSemanticCorrect: true, // 旧判分（旧编译器不强制 terminal return）
      lastProgram: {
        source: 'repos = github.search_repositories(query="agent framework", limit=30)',
        dslCorrect: true,
        compressed,
      },
    });
    const { metrics, compileFailed } = await rescoreRun(run, taskB);
    expect(metrics.jitSemanticCorrect).toBe(false);
    expect(metrics.lastProgram?.dslCorrect).toBe(false);
    expect(metrics.lastProgram?.source).toBe(run.lastProgram!.source);
    expect(metrics.lastProgram?.compressed).toEqual(compressed); // 压缩观测保留
    expect(metrics.lastProgram?.correctlyCompressedOps).toBeUndefined(); // 判 false 后不计正确压缩
    expect(compileFailed).toContain("missing_return");
  });

  test("规范 B 程序语义正确 → jitSemanticCorrect=true，correctlyCompressedOps=compressed.atomicOps", async () => {
    const run = baseRun({
      jitSemanticCorrect: false, // 旧判分（旧结构检查误判 false 的场景）
      lastProgram: { source: B_DSL, dslCorrect: false, compressed },
    });
    const { metrics, compileFailed } = await rescoreRun(run, taskB);
    expect(compileFailed).toBeUndefined();
    expect(metrics.jitSemanticCorrect).toBe(true);
    expect(metrics.lastProgram?.dslCorrect).toBe(true);
    expect(metrics.lastProgram?.correctlyCompressedOps).toBe(compressed.atomicOps);
  });

  test("无 source（或无 spec）的 run 保持旧 jitSemanticCorrect", async () => {
    const run = baseRun({ jitSemanticCorrect: undefined, lastProgram: undefined });
    const { metrics, compileFailed } = await rescoreRun(run, taskB);
    expect(compileFailed).toBeUndefined();
    expect(metrics.jitSemanticCorrect).toBeUndefined();
    expect(metrics.lastProgram).toBeUndefined();
  });
});

describe("rescoreRun + buildR6Cells — r6 四格按 contractMode 分区", () => {
  test("eager / compile-only / manifest 各一格 + control 一格（每格 runs=1，contractMode 透传）", async () => {
    const storedRuns: StoredRun[] = [
      // control：无 JIT（无 lastProgram / contractMode）
      baseRun({ arm: "control", executeCalls: 0, jitSemanticCorrect: undefined, lastProgram: undefined, contractMode: undefined }),
      ...(["eager", "compile-only", "manifest"] as R6ContractMode[]).map((contractMode) => baseRun({ contractMode })),
    ];
    const rescored: R5RunMetrics[] = [];
    for (const run of storedRuns) {
      rescored.push((await rescoreRun(run, taskB)).metrics);
    }
    const config: R6ReportConfig = {
      arm: "all",
      task: "B",
      samples: 1,
      rounds: 10,
      stopAfterSubmit: true,
      boundaryPolicy: true,
    };
    const cells = buildR6Cells(rescored, config);
    expect(cells.control.runs).toHaveLength(1);
    expect(cells.A.runs).toHaveLength(1);
    expect(cells.B.runs).toHaveLength(1);
    expect(cells.C.runs).toHaveLength(1);
    expect(cells.A.runs[0]!.contractMode).toBe("eager");
    expect(cells.B.runs[0]!.contractMode).toBe("compile-only");
    expect(cells.C.runs[0]!.contractMode).toBe("manifest");
    // 每格用格内 runs 独立聚合（rescore 后 jitSemanticCorrect 仍为 true）
    expect(cells.A.aggregate.runs).toBe(1);
    expect(cells.B.aggregate.runs).toBe(1);
    expect(cells.C.aggregate.runs).toBe(1);
    expect(cells.B.aggregate.eventualSemanticCorrectRate).toBe(1);
    expect(cells.B.jitGroups.reduce((sum, group) => sum + group.runs, 0)).toBe(1);
  });
});
