import { describe, expect, test } from "vitest";

import { compileExecutionDsl } from "../src/compiler/compile.js";
import { createR7HTask, computeR7HGroundTruth, r7DevelopmentTasks } from "../src/experiments/r7Tasks.js";
import { buildR7ResumeState, R7_ARMS, parseR7Flags } from "../src/experiments/r7RoutingBenchmark.js";
import { checkTaskSemantics } from "../src/experiments/taskSpec.js";
import { ToolRegistry } from "../src/tools/registry.js";

describe("R7 holdout H — shipment 域（防 prompt overfit 的 out-of-domain 任务）", () => {
  test("ground truth：active 且 eta<=7，按 eta 升序取前 3", () => {
    expect(computeR7HGroundTruth()).toEqual(["ORD-3009", "ORD-3003", "ORD-3001"]);
  });

  test("参考 DSL 程序可编译执行且语义正确（异名 + 多字段 map binding）", async () => {
    const task = createR7HTask();
    const registry = new ToolRegistry(task.tools);
    const source = [
      'orders = shipment.search_orders(query="international", limit=12)',
      "tracking = map(orders, shipment.get_tracking(order_no=_.order_id, country=_.country))",
      'active = filter(tracking, status="active")',
      'fast = select(active, "eta_days <= 7")',
      'ranked = sort(fast, key="eta_days", desc=false)',
      "top = take(ranked, 3)",
      "return top",
    ].join("\n");
    const { graph, diagnostics } = compileExecutionDsl(source, { tools: registry });
    expect(diagnostics).toEqual([]);
    const result = await checkTaskSemantics(graph, task);
    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test("development 任务只含 A/B，且不与 H 的工具 id 重合", () => {
    const tasks = r7DevelopmentTasks();
    expect(tasks.map((task) => task.id)).toEqual(["A", "B"]);
    const developmentIds = new Set(tasks.flatMap((task) => task.tools.map((tool) => tool.id)));
    const holdoutIds = createR7HTask().tools.map((tool) => tool.id);
    for (const id of holdoutIds) {
      expect(developmentIds.has(id)).toBe(false);
    }
  });
});

describe("R7 CLI / arm 定义", () => {
  test("七臂唯一且包含 control / tool-surface / positive 三类", () => {
    expect(R7_ARMS.map((arm) => arm.id)).toEqual(["C0", "T0", "T1", "T2", "T3", "T4", "P0"]);
    expect(R7_ARMS.filter((arm) => arm.kind === "tool-surface")).toHaveLength(5);
    expect(R7_ARMS.filter((arm) => arm.kind === "control")).toHaveLength(1);
    expect(R7_ARMS.filter((arm) => arm.kind === "positive")).toHaveLength(1);
  });

  test("parseR7Flags：默认全臂全任务，支持 task/arm/samples/rounds", () => {
    expect(parseR7Flags([]).task).toBe("all");
    expect(parseR7Flags([]).arms).toHaveLength(7);
    expect(parseR7Flags(["--task=H"]).task).toBe("H");
    expect(parseR7Flags(["--arm=T0,T4"]).arms).toEqual(["T0", "T4"]);
    expect(parseR7Flags(["--samples=3", "--rounds=5"]).samples).toBe(3);
    expect(parseR7Flags(["--samples=3", "--rounds=5"]).rounds).toBe(5);
    expect(parseR7Flags(["--resume=logs/experiments/r7-routing-x"]).resume).toBe("logs/experiments/r7-routing-x");
  });
});

describe("R7 resume state（断点续跑纯函数）", () => {
  test("旧报告无 sampleIndex：按 cell 内追加顺序回填 1..N", () => {
    const state = buildR7ResumeState({
      mode: "r7-routing-discovery",
      runs: [
        { r7Arm: "T0", taskId: "B" },
        { r7Arm: "T0", taskId: "B" },
        { r7Arm: "P0", taskId: "B" },
      ] as never,
    });
    expect(state.runsByCell.get("T0/B")?.map((run) => run.sampleIndex)).toEqual([1, 2]);
    expect(state.runsByCell.get("P0/B")?.map((run) => run.sampleIndex)).toEqual([1]);
    expect(state.completedSamplesByCell.get("T0/B")).toEqual(new Set([1, 2]));
  });

  test("新报告尊重显式 sampleIndex（跳过已完成的 sample）", () => {
    const state = buildR7ResumeState({
      mode: "r7-routing-discovery",
      runs: [
        { r7Arm: "T0", taskId: "B", sampleIndex: 3 },
      ] as never,
    });
    expect(state.runsByCell.get("T0/B")?.map((run) => run.sampleIndex)).toEqual([3]);
    expect(state.completedSamplesByCell.get("T0/B")?.has(3)).toBe(true);
  });

  test("非 R7 report mode 抛错", () => {
    expect(() => buildR7ResumeState({ mode: "r5-autonomous-offloading", runs: [] })).toThrow(/不是 R7 report/);
  });
});
