import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { compileExecutionDsl } from "../src/compiler/compile.js";
import { execute } from "../src/runtime/runtime.js";
import type { RegisteredTool } from "../src/tools/definition.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { R5_TASKS } from "../src/experiments/r5Tasks.js";
import {
  aggregateR5,
  compressedPath,
  r5ControlSystemPrompt,
  r5TreatmentSystemPrompt,
  writeR5Report,
  type R5RunMetrics,
} from "../src/experiments/r5OffloadingBenchmark.js";

describe("系统提示词：两个 arm 的唯一差异是 JIT 能力", () => {
  test("control：普通 Agent，完全不知道 JIT", () => {
    const prompt = r5ControlSystemPrompt();
    expect(prompt).toContain("自主 Agent");
    expect(prompt).not.toContain("jit_");
    expect(prompt).not.toContain("DSL");
  });

  test("treatment：双通道 + 是否使用由模型决定（不强制 JIT）", () => {
    const prompt = r5TreatmentSystemPrompt();
    expect(prompt).toContain("jit_describe_tools");
    expect(prompt).toContain("jit_execute_program");
    expect(prompt).toContain("由你决定");
    expect(prompt).toContain("不要用 JIT");
    expect(prompt).toContain("host alias（github_get_repository）");
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
    expect(compressed.joinNodes).toBe(0);
    expect(compressed.returnNodes).toBe(1);
    expect(compressed.atomicOps).toBe(1 + 4 + 2 + 0 + 1);
  });

  test("graph 为空数组时全部为 0", () => {
    const compressed = compressedPath({ schema_version: "1", nodes: [] }, []);
    expect(compressed.atomicOps).toBe(0);
    expect(compressed.fanoutSum).toBe(0);
  });
});

describe("aggregateR5 — 新指标汇总", () => {
  const base: R5RunMetrics = {
    arm: "treatment",
    taskId: "A",
    path: "ordinary",
    rounds: 3,
    tokens: { input: 1, output: 1, cacheRead: 0, total: 2 },
    latencyMs: 0,
    businessCalls: [],
    describeCalls: 0,
    executeCalls: 0,
    answerCorrect: true,
    finalText: "",
  };
  const dslRun = (taskId: "B" | "C", atomicOps: number): R5RunMetrics => ({
    ...base,
    taskId,
    path: "dsl",
    executeCalls: 1,
    lastProgram: {
      source: "…",
      dslCorrect: true,
      compressed: { toolNodes: 2, mapNodes: 2, fanoutSum: 34, computeNodes: 5, joinNodes: 1, returnNodes: 1, atomicOps },
    },
  });

  test("adoption / precision / unnecessary / compressed 汇总", () => {
    const agg = aggregateR5([base, dslRun("B", 43), dslRun("C", 8)], "treatment");
    expect(agg.runs).toBe(3);
    expect(agg.adoptionRate).toBe(2 / 3); // B/C 主动用 JIT，A 没有
    expect(agg.offloadPrecision).toBe(1); // 该 JIT 的任务（B/C）全部用了
    expect(agg.unnecessaryOffloadRate).toBe(0); // A 没有用
    expect(agg.avgCompressedOps).toBe((43 + 8) / 2);
  });

  test("A 型反而用 JIT → unnecessary offload rate = 1", () => {
    const agg = aggregateR5([{ ...base, path: "dsl", executeCalls: 1 }], "treatment");
    expect(agg.adoptionRate).toBe(1);
    expect(agg.offloadPrecision).toBe(0); // 没有该 JIT 的任务
    expect(agg.unnecessaryOffloadRate).toBe(1);
    expect(agg.avgCompressedOps).toBe(0); // 无成功程序 details
  });

  test("B/C 该 JIT 但没用 → offload precision = 0", () => {
    const agg = aggregateR5([{ ...base, taskId: "B", path: "ordinary" }, { ...base, taskId: "C", path: "maxed_out" }], "treatment");
    expect(agg.adoptionRate).toBe(0);
    expect(agg.offloadPrecision).toBe(0);
  });

  test("control 臂的 runs 被过滤（aggregate 只看自己 arm）", () => {
    const control = { ...base, arm: "control" as const, taskId: "B" as const, path: "ordinary" as const };
    const agg = aggregateR5([control, base], "treatment");
    expect(agg.runs).toBe(1);
  });
});

describe("writeR5Report — 结果记录到 log（report.json）", () => {
  test("写入配置 + 任务元数据 + 全部 runs + 双 arm 汇总，JSON 可读回", () => {
    const runs: R5RunMetrics[] = [
      {
        arm: "control",
        taskId: "A",
        path: "ordinary",
        rounds: 2,
        tokens: { input: 100, output: 50, cacheRead: 0, total: 150 },
        latencyMs: 2000,
        businessCalls: ["github_get_repository"],
        describeCalls: 0,
        executeCalls: 0,
        answerCorrect: true,
        finalText: "1600, TypeScript",
      },
      {
        arm: "treatment",
        taskId: "B",
        path: "dsl",
        rounds: 4,
        tokens: { input: 1000, output: 500, cacheRead: 0, total: 1500 },
        latencyMs: 15000,
        businessCalls: [],
        describeCalls: 1,
        executeCalls: 2,
        answerCorrect: false,
        finalText: "…",
        lastProgram: {
          source: "repos = github.search_repositories(query=\"agent framework\", limit=30)",
          dslCorrect: false,
          compressed: { toolNodes: 2, mapNodes: 2, fanoutSum: 34, computeNodes: 5, joinNodes: 1, returnNodes: 1, atomicOps: 43 },
        },
      },
    ];
    const aggregates = {
      control: aggregateR5(runs, "control"),
      treatment: aggregateR5(runs, "treatment"),
    };

    const outDir = path.join(os.tmpdir(), `r5-report-test-${Date.now()}`);
    const reportPath = writeR5Report(outDir, { arm: "both", task: "all", samples: 1, rounds: 10 }, R5_TASKS, runs, aggregates);
    try {
      expect(fs.existsSync(reportPath)).toBe(true);
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
        mode: string;
        config: { arm: string; task: string; samples: number; rounds: number };
        tasks: Array<{ id: string; name: string; prompt: string; oracle: string[] }>;
        aggregates: Record<string, { runs: number; adoptionRate: number }>;
        runs: Array<{ arm: string; taskId: string; path: string }>;
      };
      expect(report.mode).toBe("r5-autonomous-offloading");
      expect(report.config).toEqual({ arm: "both", task: "all", samples: 1, rounds: 10 });
      expect(report.tasks.map((task) => task.id)).toEqual(["A", "B", "C"]);
      // 每个任务都记录了 prompt 与 oracle（RegExp 已序列化为字符串）
      for (const task of report.tasks) {
        expect(task.prompt.length).toBeGreaterThan(0);
        expect(task.oracle.length).toBeGreaterThan(0);
      }
      expect(report.aggregates.control.runs).toBe(1);
      expect(report.aggregates.treatment.runs).toBe(1);
      expect(report.runs).toHaveLength(2);
      expect(report.runs[1]!.path).toBe("dsl");
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
