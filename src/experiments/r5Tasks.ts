import { Type } from "typebox";
import { defineTool, type RegisteredTool, type ToolContract } from "../tools/definition.js";
import {
  ADVERSARIAL_REPOS,
  createAdversarialGithubTools,
} from "../tools/providers/github/mock.js";
import { computeR4eAnswer } from "./r4eBenchmark.js";
import type { TaskSpec } from "./taskSpec.js";

/**
 * R5 — Autonomous Offloading 任务集（A / B / C 三类）。
 *
 * 设计约束：task prompt **中性**——不点名工具 id、不出现 "DSL" / "程序" 等机制词，
 * 模型只被告知目标；是否使用 JIT 由它自己决定（由 experiment harness 的系统提示词控制）。
 *
 * 三类任务的目标行为：
 * - A（不值得 JIT）：单个工具调用即可完成 → 理想行为是直接调用业务工具；
 * - B（明显值得 JIT）：search 30 → details × 30 → 分支两路 score → merge_by_key → filter → rank →
 *   理想行为是 describe → execute 一次程序化（复用 R4e adversarial 数据与正确性判定）；
 * - C（混合型）：先读 issue → Agent 语义判断选出候选 → 对候选做批量确定性处理（取分 + 排序）
 *   → 理想行为是 reasoning → atomic tools → reasoning → JIT 段 → 总结。
 */

// ---------------------------------------------------------------------------
// A 型：不值得 JIT（单个 get_repository）
// ---------------------------------------------------------------------------

const A_TARGET = "adv/org-repo-2";

/** A 型工具集：只要 get_repository（adversarial mock 数据，确定性）。 */
function buildATools(): RegisteredTool[] {
  return createAdversarialGithubTools().filter((tool) => tool.id === "github.get_repository");
}

// ---------------------------------------------------------------------------
// B 型：明显值得 JIT（R4e 分支 + 重组流水线，N=30）
// ---------------------------------------------------------------------------

const RATIO_THRESHOLD = 0.15;
const SCORE_THRESHOLD = 100;
const B_TAKE_COUNT = 3;
const B_LIMIT = 30;

/** B 型工具集：search / get_repository / get_contributor_stats / list_commits。 */
function buildBTools(): RegisteredTool[] {
  return createAdversarialGithubTools().filter((tool) =>
    [
      "github.search_repositories",
      "github.get_repository",
      "github.get_contributor_stats",
      "github.list_commits",
    ].includes(tool.id),
  );
}

/** B 型 DSL 路径的图语义检查 spec（与 R4e n=30 任务一致）。 */
export const R5_B_SPEC: TaskSpec = {
  query: "agent framework",
  queryTokens: ["agent framework"],
  limit: B_LIMIT,
  takeCount: B_TAKE_COUNT,
  bindings: { full_name: "full_name" },
  sortKey: "score",
  sortDesc: true,
  stageTools: ["github.get_repository"],
  computeExprs: { ratio: "forks / stars" },
  selectPreds: [`ratio > ${RATIO_THRESHOLD}`, `ratio <= ${RATIO_THRESHOLD}`, `score >= ${SCORE_THRESHOLD}`],
  mergeSpec: {
    key: "full_name",
    sourceCount: 3,
    extraTools: ["github.get_contributor_stats", "github.list_commits"],
  },
};

/** B 型 oracle：确定性 mock 数据上的正确答案（前 3 个仓库完整名称）。 */
export function computeR5GroundTruthB(): string[] {
  const details: { full_name: string; stars: number; forks: number; language: string }[] = ADVERSARIAL_REPOS.map(
    (row) => ({ full_name: row.full_name, stars: row.stars, forks: row.forks, language: row.language }),
  );
  const statsMap: Record<string, { score: number }> = {};
  const commitMap: Record<string, { score: number }> = {};
  for (const row of ADVERSARIAL_REPOS) {
    const path = row.forks / row.stars > RATIO_THRESHOLD ? statsMap : commitMap;
    path[row.full_name] = {
      score: row.forks / row.stars > RATIO_THRESHOLD ? row.contributor_count * 3 : row.total_commits * 2,
    };
  }
  return computeR4eAnswer(details, statsMap, commitMap, {
    ratioThreshold: RATIO_THRESHOLD,
    scoreThreshold: SCORE_THRESHOLD,
    takeCount: B_TAKE_COUNT,
  });
}

// ---------------------------------------------------------------------------
// C 型：混合型（语义判断 → JIT 确定性段）
// ---------------------------------------------------------------------------

export interface R5Issue {
  number: number;
  title: string;
  body: string;
  comments: number;
}

/** C 型 issue 数据：8 个，缺陷 issue 的 body 命中 BUG_MARKERS（确定性可判定）。 */
export const R5_ISSUES: readonly R5Issue[] = [
  { number: 1, title: "Crash on startup with empty config", body: "Application crashes immediately with a TypeError when the config file is empty.", comments: 3 },
  { number: 2, title: "Add dark mode support", body: "A dark theme would improve the experience for low-light environments.", comments: 5 },
  { number: 3, title: "Intermittent API request failures", body: "API requests fail randomly; the retry logic appears broken under load.", comments: 4 },
  { number: 4, title: "Improve documentation coverage", body: "Docs miss several advanced features and configuration options.", comments: 2 },
  { number: 5, title: "Data loss when saving large files", body: "Saving large files loses data silently; the write path corrupts content.", comments: 7 },
  { number: 6, title: "Refactor database layer", body: "Clean up legacy schema handling and reduce duplication.", comments: 1 },
  { number: 7, title: "Search returns wrong results", body: "Search is broken after the upgrade: wrong ranking and missing matches.", comments: 6 },
  { number: 8, title: "Add CSV export", body: "Support exporting workspaces to CSV.", comments: 2 },
];

/** body 命中任一 marker 即判定为缺陷 issue（oracle 的确定性依据）。 */
export const BUG_MARKERS = ["crash", "broken", "loses", "corrupt", "wrong"];

export function isBugIssue(issue: R5Issue): boolean {
  const body = issue.body.toLowerCase();
  return BUG_MARKERS.some((marker) => body.includes(marker));
}

/** 确定性严重性评分：缺陷 issue 额外 +40，使"是否缺陷"直接决定排名（分错 → 答案变）。 */
export function issueScore(issue: R5Issue): number {
  return issue.comments * 3 + (isBugIssue(issue) ? 40 : 0);
}

/**
 * C 型 candidate 池：默认 8 个（R5_ISSUES），可扩展为任意数量（P2 C-scaling：
 * candidate 数 4 / 10 / 20 / 40 找 autonomous offload threshold）。
 * 扩展部分确定性生成：i % 4 === 0 为缺陷 issue（body 命中 BUG_MARKERS），
 * 评分（comments 模式）随序号变化，保证 oracle 随规模变化且可判定。
 */
export function generateCandidates(count: number): R5Issue[] {
  if (count <= R5_ISSUES.length) return R5_ISSUES.slice(0, count);
  const issues: R5Issue[] = [...R5_ISSUES];
  for (let i = R5_ISSUES.length + 1; issues.length < count; i += 1) {
    const isBug = i % 4 === 0;
    issues.push({
      number: i,
      title: isBug ? `Regression in scenario ${i}` : `Feature request #${i}`,
      body: isBug
        ? `Scenario ${i} crashes after the upgrade; search returns wrong results.`
        : `Nice-to-have: add support for scenario ${i}.`,
      comments: i % 9,
    });
  }
  return issues;
}

/** C 型 oracle：缺陷 issue 中评分前 2 的标题。 */
export function r5TaskCOracle(issues: readonly R5Issue[] = R5_ISSUES): string[] {
  return issues
    .filter(isBugIssue)
    .sort((left, right) => issueScore(right) - issueScore(left))
    .slice(0, 2)
    .map((issue) => issue.title);
}

/** C 型 DSL 路径的图语义检查 spec。 */
export const R5_C_SPEC: TaskSpec = {
  sourceTool: "github.get_issues",
  takeCount: 2,
  bindings: { number: "number" },
  sortKey: "score",
  sortDesc: true,
  stageTools: ["github.get_issue_score"],
};

interface CContracts {
  listIssues: ToolContract;
  getIssue: ToolContract;
  getIssues: ToolContract;
  getIssueScore: ToolContract;
}

const C_CONTRACTS: CContracts = {
  listIssues: defineTool({
    id: "github.list_issues",
    label: "List repository issues",
    description: "获取仓库的 issue 列表（标题 + 评论数，不含正文）。",
    inputSchema: Type.Object({ limit: Type.Optional(Type.Integer()) }, { additionalProperties: false }),
    outputSchema: Type.Array(
      Type.Object(
        { number: Type.Integer(), title: Type.String(), state: Type.String(), comments: Type.Integer() },
        { additionalProperties: false },
      ),
    ),
  }),
  getIssue: defineTool({
    id: "github.get_issue",
    label: "Get an issue",
    description: "按 number 获取单个 issue 的完整内容（标题 + 正文）。",
    inputSchema: Type.Object({ number: Type.Integer() }, { additionalProperties: false }),
    outputSchema: Type.Object(
      { number: Type.Integer(), title: Type.String(), body: Type.String() },
      { additionalProperties: false },
    ),
  }),
  getIssues: defineTool({
    id: "github.get_issues",
    label: "Get issues by numbers",
    description: "按 number 列表批量获取 issue（列表摘要形态，供程序化下游引用）。",
    inputSchema: Type.Object(
      { numbers: Type.Array(Type.Integer()) },
      { additionalProperties: false },
    ),
    outputSchema: Type.Array(
      Type.Object(
        { number: Type.Integer(), title: Type.String(), state: Type.String(), comments: Type.Integer() },
        { additionalProperties: false },
      ),
    ),
  }),
  getIssueScore: defineTool({
    id: "github.get_issue_score",
    label: "Get issue severity score",
    description: "获取单个 issue 的严重性评分（确定性分值）。",
    inputSchema: Type.Object({ number: Type.Integer() }, { additionalProperties: false }),
    outputSchema: Type.Object(
      { number: Type.Integer(), score: Type.Integer() },
      { additionalProperties: false },
    ),
  }),
};

/** C 型 mock 工具：确定性假数据（issue 表 + 评分规则）。issues 参数支持 C-scaling。 */
export function createR5IssueTools(issues: readonly R5Issue[] = R5_ISSUES): RegisteredTool[] {
  const issueByNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const summary = (issue: R5Issue) => ({ number: issue.number, title: issue.title, state: "open", comments: issue.comments });
  return [
    {
      ...C_CONTRACTS.listIssues,
      execute: async (args) => {
        const limit = Number((args as Record<string, unknown>).limit ?? issues.length);
        return issues.slice(0, limit).map(summary);
      },
    },
    {
      ...C_CONTRACTS.getIssue,
      execute: async (args) => {
        const number = Number((args as Record<string, unknown>).number);
        const issue = issueByNumber.get(number);
        if (!issue) throw new Error(`未知 issue number：${number}`);
        return { number: issue.number, title: issue.title, body: issue.body };
      },
    },
    {
      ...C_CONTRACTS.getIssues,
      execute: async (args) => {
        const numbers = ((args as Record<string, unknown>).numbers ?? []) as number[];
        return issues.filter((issue) => numbers.includes(issue.number)).map(summary);
      },
    },
    {
      ...C_CONTRACTS.getIssueScore,
      execute: async (args) => {
        const number = Number((args as Record<string, unknown>).number);
        const issue = issueByNumber.get(number);
        if (!issue) throw new Error(`未知 issue number：${number}`);
        return { number, score: issueScore(issue) };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// 任务集
// ---------------------------------------------------------------------------

export type R5TaskId = "A" | "B" | "C";

export interface R5Task {
  id: R5TaskId;
  name: string;
  /** 中性 task prompt：不点名工具、不预设机制 */
  prompt: string;
  /** mock 工具（含 execute；每任务的 registry 独立，无跨任务冲突） */
  tools: readonly RegisteredTool[];
  /** DSL 路径的图语义检查 spec（A 型无可程序化的流水线 → undefined） */
  spec?: TaskSpec;
  /** 最终答案 oracle（最终文本 / 程序结果需全部命中）：字符串按子串匹配，RegExp 按 test */
  oracle: readonly (string | RegExp)[];
  /** 可确定性 offload 的流水线工具 canonical id（整个 pipeline 都可 JIT 化的任务才有；
   *  A/C 的语义阶段必须执行 → undefined）。用于统计 preOffloadPipelineCalls / timelyOffload。 */
  pipelineToolIds?: readonly string[];
}

export const R5_TASKS: readonly R5Task[] = [
  {
    id: "A",
    name: "single-repo-detail",
    prompt: "查询仓库 adv/org-repo-2 的详细情况，返回它的 star 数与主要编程语言。",
    tools: buildATools(),
    oracle: [/1[,，]?600/, "TypeScript"],
  },
  {
    id: "B",
    name: "repo-score-pipeline",
    prompt:
      "搜索 GitHub 上活跃的 agent 框架仓库（查询条件用 agent framework），取前 30 个。对每个仓库获取它的详细数据（star 数与 fork 数）。" +
      "然后按 fork/star 比值（ratio = forks / stars）分支：比值 > 0.15 的仓库获取贡献者路径的分数，其余仓库获取提交路径的分数（两条路径返回的分数同一尺度，可直接比较）。" +
      "把每条分数对应回它所属的仓库，只保留分数 >= 100 的仓库，按分数从高到低取前 3 个，返回它们的完整名称（owner/repo）。",
    tools: buildBTools(),
    spec: R5_B_SPEC,
    oracle: computeR5GroundTruthB(),
    // B 的整个流水线都可确定性 offload → 用于 timelyOffload（JIT 前不应执行掉任何流水线调用）
    pipelineToolIds: [
      "github.search_repositories",
      "github.get_repository",
      "github.get_contributor_stats",
      "github.list_commits",
    ],
  },
  createR5CTask(), // 默认 candidate=8；--candidates=N 时用 createR5CTask(N) 替换（P2 C-scaling）
];

/**
 * C 型任务工厂（P2 C-scaling）：candidate 数量可配置（默认 8 = R5_ISSUES）。
 * 中性 prompt / mock 工具 / oracle 全部随 candidate 集合生成，spec 形状不变。
 */
export function createR5CTask(candidateCount: number = R5_ISSUES.length): R5Task {
  const issues = generateCandidates(candidateCount);
  return {
    id: "C",
    name: "issue-hybrid",
    prompt:
      "仓库 mock/org-repo-0 的 issue 列表里混着真实缺陷与普通请求。先获取 issue 列表，再阅读若干 issue 的标题与内容，判断哪些与 bug/故障相关" +
      "（例如崩溃、报错、数据丢失、结果错误等），把这些作为候选。对每个候选 issue 获取它的严重性评分，按评分从高到低取前 2 个，返回它们的标题与评分，并附一句总结。",
    tools: createR5IssueTools(issues),
    spec: R5_C_SPEC,
    oracle: r5TaskCOracle(issues),
  };
}
