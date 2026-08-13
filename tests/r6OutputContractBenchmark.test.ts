import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  createAdversarialGithubTools,
  createOpaqueAdversarialGithubTools,
} from "../src/tools/providers/github/mock.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { renderCompactManifest } from "../src/tools/compactContractRenderer.js";
import {
  aggregateR5,
  classifyCompileErrorCode,
  compileErrorBreakdown,
  deriveR5Metrics,
  r5TreatmentSystemPrompt,
  type R5RunDerivationInput,
  type R5RunMetrics,
  type R5ToolCallRecord,
} from "../src/experiments/r5OffloadingBenchmark.js";
import { createR5BOpaqueTask, R5_B_OPAQUE_SPEC } from "../src/experiments/r5Tasks.js";
import {
  buildR6OutputContractCells,
  judgeOutputContractConclusion,
  parseR6OutputContractFlags,
  R6_OUTPUT_CONTRACT_CELLS,
  writeR6OutputContractReport,
  type R6OutputContractConfig,
  type R6OutputContractCellId,
} from "../src/experiments/r6OutputContractBenchmark.js";

// ---------------------------------------------------------------------------
// REQ-1/REQ-2：opaque 工具/任务等价性 + 不泄露
// ---------------------------------------------------------------------------

describe("R6.2 opaque tool variant — 与 transparent 完全等价", () => {
  const transparent = createAdversarialGithubTools();
  const opaque = createOpaqueAdversarialGithubTools();
  const byId = (tools: typeof transparent): Map<string, (typeof transparent)[number]> =>
    new Map(tools.map((tool) => [tool.id, tool]));

  test("search：opaque 返回 repo_ref（= full_name），limit 语义一致", async () => {
    const result = (await byId(opaque).get("github.search_repositories")!.execute({ query: "x", limit: 5 })) as Array<{
      repo_ref: string;
    }>;
    expect(result).toEqual([
      { repo_ref: "adv/org-repo-0" },
      { repo_ref: "adv/org-repo-1" },
      { repo_ref: "adv/org-repo-2" },
      { repo_ref: "adv/org-repo-3" },
      { repo_ref: "adv/org-repo-4" },
    ]);
  });

  test("get_repository / 两路 score：字段按 mapping 重命名后逐值相等", async () => {
    const tRepo = (await byId(transparent).get("github.get_repository")!.execute({ full_name: "adv/org-repo-0" })) as Record<
      string,
      unknown
    >;
    const oRepo = (await byId(opaque).get("github.get_repository")!.execute({ full_name: "adv/org-repo-0" })) as Record<
      string,
      unknown
    >;
    expect(oRepo).toEqual({ repo_ref: "adv/org-repo-0", metric_x: 80, metric_y: 530, metric_z: "TypeScript" });
    expect(oRepo.repo_ref).toBe(tRepo.full_name);
    expect(oRepo.metric_x).toBe(tRepo.forks);
    expect(oRepo.metric_y).toBe(tRepo.stars);
    expect(oRepo.metric_z).toBe(tRepo.language);

    const oStats = (await byId(opaque).get("github.get_contributor_stats")!.execute({ full_name: "adv/org-repo-0" })) as Record<
      string,
      unknown
    >;
    expect(oStats).toEqual({ repo_ref: "adv/org-repo-0", aggregate_value: 801 });
    const oCommits = (await byId(opaque).get("github.list_commits")!.execute({ full_name: "adv/org-repo-1" })) as Record<
      string,
      unknown
    >;
    expect(oCommits).toEqual({ repo_ref: "adv/org-repo-1", aggregate_value: 750 });
  });

  test("fieldHints 正确（mapping 标签），description/label 不泄露字段名", () => {
    const getRepo = byId(opaque).get("github.get_repository")!;
    expect(getRepo.fieldHints).toEqual({
      repo_ref: "repository identity",
      metric_x: "forks",
      metric_y: "stars",
      metric_z: "language",
    });
    const stats = byId(opaque).get("github.get_contributor_stats")!;
    expect(stats.fieldHints).toEqual({ repo_ref: "repository identity", aggregate_value: "score" });
    for (const tool of opaque) {
      const text = `${tool.label ?? ""} ${tool.description ?? ""}`;
      expect(text).not.toMatch(/full_name|forks|stars|score/);
    }
  });

  test("opaque 任务与 transparent 任务 oracle 一致、answerField 不同", () => {
    const opaqueTask = createR5BOpaqueTask();
    expect(opaqueTask.spec?.answerField).toBe("repo_ref");
    expect(R5_B_OPAQUE_SPEC.answerField).toBe("repo_ref");
    // opaque oracle 与 transparent Task B（computeR5GroundTruthB）一致
    expect(opaqueTask.oracle).toEqual(["adv/org-repo-0", "adv/org-repo-1", "adv/org-repo-17"]);
  });
});

// ---------------------------------------------------------------------------
// REQ-3：manifest 语义标签
// ---------------------------------------------------------------------------

describe("R6.2 renderCompactManifest — opaque 标签 + transparent 不变", () => {
  test("opaque manifest 携带最小语义标签（[label] 后缀）", () => {
    const registry = new ToolRegistry(createOpaqueAdversarialGithubTools());
    const manifest = renderCompactManifest(registry, ["github.get_repository"]);
    expect(manifest).toContain("repo_ref: string[repository identity]");
    expect(manifest).toContain("metric_x: integer[forks]");
    expect(manifest).toContain("metric_y: integer[stars]");
    expect(manifest).toContain("metric_z: string[language]");
  });

  test("transparent manifest 无 [label] 后缀（逐字节不变）", () => {
    const registry = new ToolRegistry(createAdversarialGithubTools());
    const manifest = renderCompactManifest(registry, ["github.get_repository"]);
    expect(manifest).toContain("full_name: string");
    expect(manifest).toContain("forks: integer");
    expect(manifest).not.toContain("[");
  });

  test("manifest 仍无 full-schema boilerplate", () => {
    const registry = new ToolRegistry(createOpaqueAdversarialGithubTools());
    const manifest = renderCompactManifest(registry);
    expect(manifest).not.toContain("description");
    expect(manifest).not.toContain("参数格式");
    expect(manifest).not.toContain("类型定义");
    expect(manifest).not.toContain("required");
    expect(manifest).not.toContain("$id");
  });
});

// ---------------------------------------------------------------------------
// REQ-3/三：prompt 控制变量
// ---------------------------------------------------------------------------

describe("R6.2 prompt 控制变量 — compile-only 无 output mapping / manifest 有最小映射", () => {
  test("compile-only prompt 无 manifest 段、无任何 output 字段名泄露", () => {
    const prompt = r5TreatmentSystemPrompt({ boundaryPolicy: true, contractMode: "compile-only" });
    expect(prompt).not.toContain("## Output manifest");
    expect(prompt).toContain("## Agent Execution DSL 参考");
    // 中立 DSL 参考：不泄露 full_name/stars/forks/language/score 及 opaque 字段名
    expect(prompt).not.toMatch(/full_name|stars|forks|language|score|metric_x|metric_y|repo_ref|aggregate_value/);
  });

  test("manifest prompt 携带最小 output mapping（opaque 标签）", () => {
    const opaqueManifest = renderCompactManifest(new ToolRegistry(createOpaqueAdversarialGithubTools()));
    const prompt = r5TreatmentSystemPrompt({
      boundaryPolicy: true,
      contractMode: "manifest",
      manifest: opaqueManifest,
    });
    expect(prompt).toContain("## Output manifest");
    expect(prompt).toContain("metric_x: integer[forks]");
    expect(prompt).toContain("aggregate_value: integer[score]");
  });
});

// ---------------------------------------------------------------------------
// REQ-4：CompileErrorBreakdown
// ---------------------------------------------------------------------------

describe("R6.2 compileErrorBreakdown — 错误分类", () => {
  test("分类映射正确", () => {
    expect(classifyCompileErrorCode("syntax")).toBe("syntaxOrCompleteness");
    expect(classifyCompileErrorCode("duplicate_name")).toBe("syntaxOrCompleteness");
    expect(classifyCompileErrorCode("missing_return")).toBe("syntaxOrCompleteness");
    expect(classifyCompileErrorCode("duplicate_return")).toBe("syntaxOrCompleteness");
    expect(classifyCompileErrorCode("UNKNOWN_FIELD")).toBe("outputContractRelated");
    expect(classifyCompileErrorCode("config_type_mismatch")).toBe("outputContractRelated");
    expect(classifyCompileErrorCode("unknown_parameter")).toBe("outputContractRelated");
    expect(classifyCompileErrorCode("MAP_BINDING_REF_INVALID")).toBe("outputContractRelated");
    expect(classifyCompileErrorCode("unknown_tool")).toBe("other");
  });

  test("汇总三类计数", () => {
    const breakdown = compileErrorBreakdown([
      { line: 1, code: "UNKNOWN_FIELD", message: "x" },
      { line: 2, code: "config_type_mismatch", message: "x" },
      { line: 3, code: "syntax", message: "x" },
      { line: 4, code: "unknown_tool", message: "x" },
    ]);
    expect(breakdown).toEqual({ syntaxOrCompleteness: 1, outputContractRelated: 2, other: 1 });
  });
});

// ---------------------------------------------------------------------------
// REQ-5：deriveR5Metrics repair cost 三段 + aggregate 新字段
// ---------------------------------------------------------------------------

const call = (name: string, round: number, isError = false): R5ToolCallRecord => ({
  name,
  isError,
  round,
  arguments: {},
});

describe("R6.2 deriveR5Metrics — repair cost 三段", () => {
  test("tokensBeforeFirstCompile / tokensInRepairRounds / tokensAfterSuccessfulExecution", () => {
    const input: R5RunDerivationInput = {
      arm: "treatment",
      taskId: "B",
      rounds: 4,
      maxedOut: false,
      tokens: { input: 1, output: 1, cacheRead: 0, total: 2 },
      tokenRounds: [
        { round: 1, input: 50, cacheRead: 0, output: 50, total: 100, toolCalls: [] },
        { round: 2, input: 100, cacheRead: 0, output: 100, total: 200, toolCalls: ["jit_execute_program"] },
        { round: 3, input: 150, cacheRead: 0, output: 150, total: 300, toolCalls: ["jit_execute_program"] },
        { round: 4, input: 200, cacheRead: 0, output: 200, total: 400, toolCalls: ["submit_answer"] },
      ],
      latencyMs: 0,
      toolTimeline: [call("jit_execute_program", 2, true), call("jit_execute_program", 3, false)],
      businessCalls: [],
      describeCalls: 0,
      executeCalls: 2,
      jitSemanticCorrect: true,
      executeErrors: [],
      submittedAnswer: "ok",
      finalText: "",
      oracle: [],
    };
    const metrics = deriveR5Metrics(input);
    expect(metrics.tokensBeforeFirstCompile).toBe(100);
    expect(metrics.tokensInRepairRounds).toBe(500);
    expect(metrics.repairTokens).toBe(500);
    expect(metrics.tokensAfterSuccessfulExecution).toBe(400);
  });
});

const baseRun = (overrides: Partial<R5RunMetrics> & { taskId?: "B" } = {}): R5RunMetrics => ({
  arm: "treatment",
  taskId: "B",
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

describe("R6.2 aggregateR5 — 新字段", () => {
  test("avgCompileAttempts / avgLatencyMs / firstPassSemanticSuccessRate / 错误分类占比", () => {
    const runs: R5RunMetrics[] = [
      baseRun({
        compileAttempts: 2,
        latencyMs: 100,
        firstPassSemanticSuccess: true,
        compileErrorBreakdown: { syntaxOrCompleteness: 1, outputContractRelated: 3, other: 0 },
      }),
      baseRun({
        compileAttempts: 4,
        latencyMs: 300,
        firstPassSemanticSuccess: false,
        compileErrorBreakdown: { syntaxOrCompleteness: 1, outputContractRelated: 1, other: 2 },
      }),
    ];
    const agg = aggregateR5(runs, "treatment", "B");
    expect(agg.avgCompileAttempts).toBe(3);
    expect(agg.avgLatencyMs).toBe(200);
    expect(agg.firstPassSemanticSuccessRate).toBe(0.5);
    // outputContractRelated = 3+1=4；syntaxOrCompleteness = 1+1=2；other = 0+2=2 → total 8
    expect(agg.outputContractErrorRate).toBe(4 / 8);
    expect(agg.syntaxCompletenessErrorRate).toBe(2 / 8);
  });

  test("无 compileErrorBreakdown → 错误分类占比为 0", () => {
    const agg = aggregateR5([baseRun()], "treatment", "B");
    expect(agg.outputContractErrorRate).toBe(0);
    expect(agg.syntaxCompletenessErrorRate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// REQ-6：runner
// ---------------------------------------------------------------------------

describe("R6.2 runner — flags / cells / report / 判断矩阵", () => {
  test("parseR6OutputContractFlags 默认与解析", () => {
    expect(parseR6OutputContractFlags([])).toEqual({ cell: "all", samples: 1, rounds: 10 });
    expect(parseR6OutputContractFlags(["--cell=B-O", "--samples=20"])).toEqual({ cell: "B-O", samples: 20, rounds: 10 });
    expect(() => parseR6OutputContractFlags(["--cell=X"])).toThrow(/--cell 必须是/);
  });

  test("buildR6OutputContractCells 按 contractMode + toolNaming 分格", () => {
    const runs: R5RunMetrics[] = [
      baseRun({ contractMode: "compile-only", toolNaming: "transparent" }),
      baseRun({ contractMode: "manifest", toolNaming: "transparent", manifestChars: 10, manifestEstimatedTokens: 3 }),
      baseRun({ contractMode: "compile-only", toolNaming: "opaque" }),
      baseRun({ contractMode: "manifest", toolNaming: "opaque", manifestChars: 20, manifestEstimatedTokens: 5 }),
    ];
    const config: R6OutputContractConfig = { cell: "all", samples: 1, rounds: 10 };
    const cells = buildR6OutputContractCells(runs, config);
    expect(cells["B-T"].runs).toHaveLength(1);
    expect(cells["C-T"].runs).toHaveLength(1);
    expect(cells["B-O"].runs).toHaveLength(1);
    expect(cells["C-O"].runs).toHaveLength(1);
    expect(cells["C-O"].manifestChars).toBe(20);
    expect(cells["C-O"].manifestEstimatedTokens).toBe(5);
    expect(cells["C-O"].totalTokensIncludingManifest).toBe(cells["C-O"].aggregate.avgTokens + 5);
  });

  test("writeR6OutputContractReport 落盘四格 + manifest cost", () => {
    const runs: R5RunMetrics[] = [
      baseRun({ contractMode: "compile-only", toolNaming: "transparent" }),
      baseRun({ contractMode: "manifest", toolNaming: "transparent", manifestChars: 10, manifestEstimatedTokens: 3 }),
      baseRun({ contractMode: "compile-only", toolNaming: "opaque" }),
      baseRun({ contractMode: "manifest", toolNaming: "opaque", manifestChars: 20, manifestEstimatedTokens: 5 }),
    ];
    const config: R6OutputContractConfig = { cell: "all", samples: 1, rounds: 10, boundaryPolicy: true, stopAfterSubmit: true };
    const cells = buildR6OutputContractCells(runs, config);
    const outDir = path.join(os.tmpdir(), `r6-output-contract-report-${Date.now()}`);
    try {
      const reportPath = writeR6OutputContractReport(outDir, config, [createR5BOpaqueTask()], cells, runs);
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
        mode: string;
        config: { boundaryPolicy?: boolean; stopAfterSubmit?: boolean };
        cells: Record<string, { contractMode: string; naming: string; manifestEstimatedTokens?: number }>;
      };
      expect(report.mode).toBe("r6-output-contract");
      expect(report.config.boundaryPolicy).toBe(true);
      expect(report.config.stopAfterSubmit).toBe(true);
      expect(Object.keys(report.cells)).toEqual(["B-T", "C-T", "B-O", "C-O"]);
      expect(report.cells["C-O"].naming).toBe("opaque");
      expect(report.cells["C-O"].manifestEstimatedTokens).toBe(5);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("judgeOutputContractConclusion：情况 A（transparent B≈C，opaque B 掉、C 稳）", () => {
    const runs: R5RunMetrics[] = [
      baseRun({ contractMode: "compile-only", toolNaming: "transparent", firstPassCompileSuccess: true }),
      baseRun({ contractMode: "manifest", toolNaming: "transparent", firstPassCompileSuccess: true }),
      baseRun({ contractMode: "compile-only", toolNaming: "opaque", firstPassCompileSuccess: false }),
      baseRun({ contractMode: "manifest", toolNaming: "opaque", firstPassCompileSuccess: true }),
    ];
    const cells = buildR6OutputContractCells(runs, { cell: "all", samples: 1, rounds: 10 });
    expect(judgeOutputContractConclusion(cells)).toContain("情况 A");
  });

  test("R6_OUTPUT_CONTRACT_CELLS 映射正确", () => {
    expect(R6_OUTPUT_CONTRACT_CELLS["B-T"]).toEqual({ contractMode: "compile-only", naming: "transparent", label: expect.any(String) });
    expect(R6_OUTPUT_CONTRACT_CELLS["C-O"].contractMode).toBe("manifest");
    expect(R6_OUTPUT_CONTRACT_CELLS["C-O"].naming).toBe("opaque");
  });
});
