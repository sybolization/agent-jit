import { describe, expect, test } from "vitest";

import { compileExecutionDsl } from "../src/compiler/compile.js";
import type { ExecutionGraph } from "../src/compiler/ir.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { checkTaskCorrectness, checkTaskSemantics } from "../src/experiments/taskSpec.js";
import {
  BUG_MARKERS,
  computeR5GroundTruthB,
  createR5CTask,
  createR5IssueTools,
  generateCandidates,
  isBugIssue,
  issueScore,
  R5_ISSUES,
  R5_TASKS,
  r5TaskCOracle,
  r5TaskCOracleNumbers,
} from "../src/experiments/r5Tasks.js";
import { ADVERSARIAL_REPOS } from "../src/tools/providers/github/mock.js";

describe("R5_TASKS — 覆盖 A/B/C 三类", () => {
  test("A/B/C 各一个任务", () => {
    expect(R5_TASKS.map((task) => task.id).sort()).toEqual(["A", "B", "C"]);
  });

  test("A 型没有 spec（不可程序化流水线）；B/C 型有 DSL 图语义检查 spec", () => {
    const byId = Object.fromEntries(R5_TASKS.map((task) => [task.id, task]));
    expect(byId["A"]!.spec).toBeUndefined();
    expect(byId["B"]!.spec).toBeDefined();
    expect(byId["C"]!.spec).toBeDefined();
  });
});

describe("task prompt 中性（不点名工具、不预设机制）", () => {
  for (const task of R5_TASKS) {
    test(`${task.id}（${task.name}）：不含任何工具 id / 点号工具名`, () => {
      for (const tool of task.tools) {
        expect(task.prompt, `任务 ${task.id} 不应点名工具 ${tool.id}`).not.toContain(tool.id);
      }
      expect(task.prompt, `任务 ${task.id} 不应出现点号工具名`).not.toMatch(/[a-z]+\.[a-z_]+/);
    });

    test(`${task.id}（${task.name}）：不预设 DSL 机制`, () => {
      expect(task.prompt).not.toContain("Agent Execution DSL");
      expect(task.prompt).not.toContain("DSL");
      expect(task.prompt).not.toContain("编写程序");
    });
  }
});

describe("B 型 oracle（确定性 mock 数据）", () => {
  test("前 3 个仓库与构造注释一致（repo-0/1/17，repo-2 被阈值淘汰）", () => {
    const oracle = computeR5GroundTruthB();
    expect(oracle).toHaveLength(3);
    expect(oracle[0]).toBe("adv/org-repo-0");
    expect(oracle[1]).toBe("adv/org-repo-1");
    expect(oracle[2]).toBe("adv/org-repo-17");
    for (const name of oracle) {
      expect(ADVERSARIAL_REPOS.some((row) => row.full_name === name)).toBe(true);
    }
  });
});

describe("C 型数据与 oracle", () => {
  test("缺陷 issue 集合确定（1/3/5/7，body 命中 BUG_MARKERS）", () => {
    expect(BUG_MARKERS.length).toBeGreaterThan(0);
    const bugNumbers = R5_ISSUES.filter(isBugIssue).map((issue) => issue.number);
    expect(bugNumbers).toEqual([1, 3, 5, 7]);
  });

  test("issueScore 确定性：缺陷 issue 额外 +40，直接决定排名", () => {
    for (const issue of R5_ISSUES) {
      expect(issueScore(issue)).toBe(issue.comments * 3 + (isBugIssue(issue) ? 40 : 0));
    }
  });

  test("C 型 oracle = 缺陷 issue 中评分前 2 的标题", () => {
    expect(r5TaskCOracle()).toEqual([
      "Data loss when saving large files",
      "Search returns wrong results",
    ]);
  });

  test("C 型 mock 工具确定性", async () => {
    const tools = createR5IssueTools();
    const scoreTool = tools.find((tool) => tool.id === "github.get_issue_score")!;
    const issuesTool = tools.find((tool) => tool.id === "github.get_issues")!;
    const listTool = tools.find((tool) => tool.id === "github.list_issues")!;
    expect(await scoreTool.execute({ number: 5 })).toEqual({ number: 5, score: 61 });
    expect(await scoreTool.execute({ number: 2 })).toEqual({ number: 2, score: 15 });
    expect(await issuesTool.execute({ numbers: [1, 5, 9] })).toHaveLength(2);
    expect(await listTool.execute({ limit: 3 })).toHaveLength(3);
    await expect(scoreTool.execute({ number: 99 })).rejects.toThrow(/未知 issue number/);
  });
});

describe("C 型 candidate 可扩展（P2 C-scaling：4/10/20/40）", () => {
  test("generateCandidates：≤8 用 R5_ISSUES 前缀，>8 确定性扩展", () => {
    expect(generateCandidates(4).map((issue) => issue.number)).toEqual([1, 2, 3, 4]);
    const sixteen = generateCandidates(16);
    expect(sixteen).toHaveLength(16);
    // 扩展部分确定性：i % 4 === 0 为缺陷（body 命中 BUG_MARKERS）
    const extra = sixteen.find((issue) => issue.number === 9)!;
    expect(extra.title).toBe("Feature request #9");
    expect(isBugIssue(extra)).toBe(false);
    const bug = sixteen.find((issue) => issue.number === 12)!;
    expect(isBugIssue(bug)).toBe(true);
    expect(JSON.stringify(generateCandidates(16))).toBe(JSON.stringify(generateCandidates(16))); // 确定性
  });

  test("createR5CTask(N)：prompt 中性、工具随 N 变化、oracle 可判定", async () => {
    const scaled = createR5CTask(10);
    expect(scaled.id).toBe("C");
    expect(scaled.spec).toBeDefined();
    expect(scaled.prompt).not.toMatch(/[a-z]+\.[a-z_]+/); // 中性
    expect(scaled.oracle.length).toBeGreaterThan(0);
    // 工具表确实包含 10 个 issue（list 全量返回 10 条）
    const listTool = scaled.tools.find((tool) => tool.id === "github.list_issues")!;
    expect(await listTool.execute({})).toHaveLength(10);
    // 默认 createR5CTask() 与 R5_TASKS 里的 C 等价（8 个）
    expect(r5TaskCOracle(generateCandidates(R5_ISSUES.length))).toEqual(r5TaskCOracle());
  });

  test("scaled C 的规范 DSL 程序仍通过 R5_C_SPEC（spec 形状与 candidate 数无关）", () => {
    const scaled = createR5CTask(20);
    const dsl = [
      "cands = github.get_issues(numbers=[1, 3, 5, 7, 8, 12, 16, 20])",
      "scores = map(cands, github.get_issue_score(number=_.number))",
      'ranked = sort(scores, key="score", desc=true)',
      "top = take(ranked, 2)",
      "return top",
    ].join("\n");
    const { graph } = compileExecutionDsl(dsl, { tools: new ToolRegistry(scaled.tools) });
    const check = checkTaskCorrectness(graph, scaled.spec!);
    expect(check.pass).toBe(true);
  });
});

describe("规范 DSL 程序通过各任务的图语义检查（spec 与 oracle 一致）", () => {
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

  const C_DSL = [
    "cands = github.get_issues(numbers=[1, 3, 5, 7])",
    "scores = map(cands, github.get_issue_score(number=_.number))",
    'ranked = sort(scores, key="score", desc=true)',
    "top = take(ranked, 2)",
    "return top",
  ].join("\n");

  test("B：分支 + merge_by_key + 排序 + 截取流水线通过 R5_B_SPEC", () => {
    const task = R5_TASKS.find((item) => item.id === "B")!;
    const { graph } = compileExecutionDsl(B_DSL, { tools: new ToolRegistry(task.tools) });
    const check = checkTaskCorrectness(graph, task.spec!);
    expect(check.pass).toBe(true);
    expect(check.failures).toEqual([]);
  });

  test("B：join（merge_by_key 的遗留别名）同样通过 R5_B_SPEC", () => {
    const task = R5_TASKS.find((item) => item.id === "B")!;
    const dsl = B_DSL.replace("merge_by_key(", "join(");
    const { graph } = compileExecutionDsl(dsl, { tools: new ToolRegistry(task.tools) });
    const check = checkTaskCorrectness(graph, task.spec!);
    expect(check.pass).toBe(true);
  });

  test("B：用 concat 代替 merge_by_key（分支直接拼接，score 记录自带 full_name）→ 同样通过 R5_B_SPEC", () => {
    const task = R5_TASKS.find((item) => item.id === "B")!;
    const dsl = B_DSL.replace(
      'merged = merge_by_key(details, contribs, commits, key="full_name")',
      "merged = concat(contribs, commits)",
    );
    const { graph } = compileExecutionDsl(dsl, { tools: new ToolRegistry(task.tools) });
    const check = checkTaskCorrectness(graph, task.spec!);
    // branchFlowSpec：两个分支都真正贡献到最终 score filter 即算语义正确（不绑定 merge IR shape）
    expect(check.pass).toBe(true);
  });

  test("C：候选列表 + map 评分 + 排序 + 截取通过 R5_C_SPEC", () => {
    const task = R5_TASKS.find((item) => item.id === "C")!;
    const { graph } = compileExecutionDsl(C_DSL, { tools: new ToolRegistry(task.tools) });
    const check = checkTaskCorrectness(graph, task.spec!);
    expect(check.pass).toBe(true);
    expect(check.failures).toEqual([]);
  });
});

describe("checkTaskSemantics — 执行级语义约束（拓扑无关）", () => {
  const taskB = R5_TASKS.find((item) => item.id === "B")!;
  const taskC = R5_TASKS.find((item) => item.id === "C")!;

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

  // concat 变体：分支结果直接拼接（不 merge_by_key 重组）——语义等价，必须 pass
  const B_CONCAT_DSL = B_DSL.replace(
    'merged = merge_by_key(details, contribs, commits, key="full_name")',
    "merged = concat(contribs, commits)",
  );

  // 直接 predicate 变体：不先 compute ratio，谓词里直接写 "forks / stars > 0.15"——语义等价，必须 pass
  const B_DIRECT_PRED_DSL = B_DSL
    .replace('ratio = compute(details, ratio="forks / stars")\n', "")
    .replace('select(ratio, "ratio > 0.15")', 'select(details, "forks / stars > 0.15")')
    .replace('select(ratio, "ratio <= 0.15")', 'select(details, "forks / stars <= 0.15")');

  // 错误变体：排序键从 score 换成 stars（前 3 名顺序错）→ 必须 fail
  const B_WRONG_SORT_DSL = B_DSL.replace('ranked = sort(kept, key="score", desc=true)', 'ranked = sort(kept, key="stars", desc=true)');

  // 错误变体：只做单分支（去掉 commit 分支，全部走 contributor_stats）→ 丢 repo-1/repo-17 → 必须 fail
  const B_SINGLE_BRANCH_DSL = [
    'repos = github.search_repositories(query="agent framework", limit=30)',
    "details = map(repos, github.get_repository(full_name=_.full_name))",
    'ratio = compute(details, ratio="forks / stars")',
    'contrib = select(ratio, "ratio > 0.15")',
    "contribs = map(contrib, github.get_contributor_stats(full_name=_.full_name))",
    'merged = merge_by_key(details, contribs, key="full_name")',
    'kept = select(merged, "score >= 100")',
    'ranked = sort(kept, key="score", desc=true)',
    "top = take(ranked, 3)",
    "return top",
  ].join("\n");

  const C_DSL = [
    "cands = github.get_issues(numbers=[1, 3, 5, 7])",
    "scores = map(cands, github.get_issue_score(number=_.number))",
    'ranked = sort(scores, key="score", desc=true)',
    "top = take(ranked, 2)",
    "return top",
  ].join("\n");

  // C 错误变体：take 3 而非 2 → 多出一个非期望 number → 必须 fail
  const C_WRONG_TAKE_DSL = C_DSL.replace("top = take(ranked, 2)", "top = take(ranked, 3)");

  const compileB = (dsl: string): ExecutionGraph =>
    compileExecutionDsl(dsl, { tools: new ToolRegistry(taskB.tools) }).graph;
  const compileC = (dsl: string): ExecutionGraph =>
    compileExecutionDsl(dsl, { tools: new ToolRegistry(taskC.tools) }).graph;

  test("B 规范 DSL（merge_by_key）→ pass=true", async () => {
    const result = await checkTaskSemantics(compileB(B_DSL), taskB);
    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test("B concat 变体（concat(contribs, commits) 代替 merge_by_key 重组）→ pass=true", async () => {
    const result = await checkTaskSemantics(compileB(B_CONCAT_DSL), taskB);
    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test("B 直接 predicate 变体（select 谓词里写 forks / stars，不先 compute ratio）→ pass=true", async () => {
    const result = await checkTaskSemantics(compileB(B_DIRECT_PRED_DSL), taskB);
    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test("B 错误变体：sort key 换成 stars（顺序错）→ pass=false", async () => {
    const result = await checkTaskSemantics(compileB(B_WRONG_SORT_DSL), taskB);
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("oracle"))).toBe(true);
  });

  test("B 错误变体：只做单分支（去掉 commit 分支）→ pass=false", async () => {
    const result = await checkTaskSemantics(compileB(B_SINGLE_BRANCH_DSL), taskB);
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("oracle"))).toBe(true);
  });

  test("C 规范 DSL → pass=true（oracle 用 r5TaskCOracleNumbers 与 answerField=number 对齐）", async () => {
    const result = await checkTaskSemantics(compileC(C_DSL), {
      tools: taskC.tools,
      oracle: r5TaskCOracleNumbers().map(String),
      spec: taskC.spec,
    });
    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test("C 错误变体：take(ranked, 3) 代替 2 → pass=false", async () => {
    const result = await checkTaskSemantics(compileC(C_WRONG_TAKE_DSL), {
      tools: taskC.tools,
      oracle: r5TaskCOracleNumbers().map(String),
      spec: taskC.spec,
    });
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("oracle"))).toBe(true);
  });

  test("无 return 的手工图 → pass=false 且 failures 含 return", async () => {
    // compile 强制要求 terminal return，无法用 DSL 构造无 return 的图；手工构造等价图
    const graph: ExecutionGraph = {
      schema_version: "1",
      nodes: [
        {
          id: "repos",
          kind: "tool",
          tool: "github.search_repositories",
          args: { query: { kind: "literal", value: "agent framework" }, limit: { kind: "literal", value: 30 } },
        },
      ],
    };
    const result = await checkTaskSemantics(graph, taskB);
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("return"))).toBe(true);
  });

  test("无 spec 的任务（spec: undefined）→ pass=false", async () => {
    const result = await checkTaskSemantics(compileB(B_DSL), {
      tools: taskB.tools,
      oracle: taskB.oracle,
      spec: undefined,
    });
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("spec"))).toBe(true);
  });
});
