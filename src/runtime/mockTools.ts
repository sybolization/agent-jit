import { githubTools } from "../compiler/registry.js";
import type { ToolSpec } from "../compiler/registry.js";
import type { RuntimeTool } from "./runtime.js";

/**
 * Mock GitHub tools：与 `githubTools` 相同的 spec，但执行是确定性的
 * 假数据（search 固定返回、get_repository 等带随机延迟）。
 *
 * 用途：在接入真实 GitHub adapter（P4）之前，验证 runtime 的并发、
 * 动态 map 展开、value 传播与 trace——不碰网络、不碰 token。
 */

export interface MockGithubOptions {
  /** get_repository 等工具的随机延迟范围（ms），默认 [20, 100]。 */
  delayMs?: [number, number];
  /** search 返回的仓库条数，默认 10。 */
  repositoryCount?: number;
}

/** R4e adversarial 仓库数据：确定性、每步必要（分支/join/阈值/字段任一错 → 答案变）。 */
export interface AdversarialRepoRow {
  full_name: string;
  stars: number;
  forks: number;
  language: "TypeScript" | "JavaScript";
  contributor_count: number;
  total_commits: number;
}

export const ADVERSARIAL_REPOS: readonly AdversarialRepoRow[] = [
  // 关键仓库（构造约束，见 tests/mockTools.test.ts 的置换断言）：
  // repo-0（A）：ratio≈0.151 → contributors 路径，score=801 —— 正确 top1；
  // repo-1（B）：ratio≈0.149 → commits 路径，score=750 —— 正确 top2；
  // repo-2（C）：score=90（<阈值 100）且是全体第 3 高分 —— 漏阈值时错误进答案（N=15 GT 长度 2）；
  // repo-17：ratio=0.15 → commits 路径，score=170 —— N=30 正确 top3（过阈值者 3 个，N 梯度分叉）；
  // 其余仓库 score 全部 < 90（保证 C 稳居第 3）。
  // 陷阱：repo-0 若被分到 commits → score=8；repo-1 若被分到 contributors → score=9；
  //       repo-17 若用 < 而非 <=（0.15 分到 contributors）→ score=24。
  { full_name: "adv/org-repo-0", stars: 530, forks: 80, language: "TypeScript", contributor_count: 267, total_commits: 4 },
  { full_name: "adv/org-repo-1", stars: 670, forks: 100, language: "TypeScript", contributor_count: 3, total_commits: 375 },
  { full_name: "adv/org-repo-2", stars: 1600, forks: 320, language: "TypeScript", contributor_count: 30, total_commits: 45 },
  { full_name: "adv/org-repo-3", stars: 900, forks: 126, language: "JavaScript", contributor_count: 20, total_commits: 40 },
  { full_name: "adv/org-repo-4", stars: 2000, forks: 300, language: "TypeScript", contributor_count: 10, total_commits: 40 },
  { full_name: "adv/org-repo-5", stars: 1800, forks: 360, language: "JavaScript", contributor_count: 20, total_commits: 20 },
  { full_name: "adv/org-repo-6", stars: 1100, forks: 220, language: "TypeScript", contributor_count: 12, total_commits: 30 },
  { full_name: "adv/org-repo-7", stars: 1500, forks: 200, language: "JavaScript", contributor_count: 15, total_commits: 42 },
  { full_name: "adv/org-repo-8", stars: 1200, forks: 180, language: "TypeScript", contributor_count: 18, total_commits: 40 },
  { full_name: "adv/org-repo-9", stars: 1000, forks: 140, language: "TypeScript", contributor_count: 10, total_commits: 42 },
  { full_name: "adv/org-repo-10", stars: 800, forks: 112, language: "JavaScript", contributor_count: 22, total_commits: 30 },
  { full_name: "adv/org-repo-11", stars: 700, forks: 140, language: "TypeScript", contributor_count: 28, total_commits: 15 },
  { full_name: "adv/org-repo-12", stars: 600, forks: 120, language: "TypeScript", contributor_count: 25, total_commits: 10 },
  { full_name: "adv/org-repo-13", stars: 500, forks: 250, language: "TypeScript", contributor_count: 15, total_commits: 5 },
  { full_name: "adv/org-repo-14", stars: 400, forks: 20, language: "JavaScript", contributor_count: 5, total_commits: 10 },
  { full_name: "adv/org-repo-15", stars: 350, forks: 17, language: "TypeScript", contributor_count: 4, total_commits: 12 },
  { full_name: "adv/org-repo-16", stars: 460, forks: 92, language: "JavaScript", contributor_count: 8, total_commits: 8 },
  { full_name: "adv/org-repo-17", stars: 520, forks: 78, language: "TypeScript", contributor_count: 8, total_commits: 85 },
  { full_name: "adv/org-repo-18", stars: 620, forks: 93, language: "TypeScript", contributor_count: 20, total_commits: 15 },
  { full_name: "adv/org-repo-19", stars: 720, forks: 108, language: "TypeScript", contributor_count: 12, total_commits: 20 },
  { full_name: "adv/org-repo-20", stars: 820, forks: 123, language: "TypeScript", contributor_count: 28, total_commits: 10 },
  { full_name: "adv/org-repo-21", stars: 920, forks: 138, language: "TypeScript", contributor_count: 15, total_commits: 25 },
  { full_name: "adv/org-repo-22", stars: 1020, forks: 153, language: "TypeScript", contributor_count: 10, total_commits: 30 },
  { full_name: "adv/org-repo-23", stars: 1120, forks: 168, language: "TypeScript", contributor_count: 20, total_commits: 12 },
  { full_name: "adv/org-repo-24", stars: 1220, forks: 183, language: "TypeScript", contributor_count: 25, total_commits: 15 },
  { full_name: "adv/org-repo-25", stars: 1320, forks: 198, language: "TypeScript", contributor_count: 18, total_commits: 20 },
  { full_name: "adv/org-repo-26", stars: 1420, forks: 213, language: "TypeScript", contributor_count: 12, total_commits: 25 },
  { full_name: "adv/org-repo-27", stars: 540, forks: 108, language: "JavaScript", contributor_count: 8, total_commits: 12 },
  { full_name: "adv/org-repo-28", stars: 640, forks: 128, language: "TypeScript", contributor_count: 15, total_commits: 8 },
  { full_name: "adv/org-repo-29", stars: 740, forks: 148, language: "JavaScript", contributor_count: 10, total_commits: 10 },
];

/**
 * R4e adversarial mock 工具：与 githubTools 同 spec、确定性数据。
 * - search：返回前 N 个仓库（按表序，忽略 query）；
 * - get_repository：{full_name, forks, stars, language}；
 * - get_contributor_stats：{full_name, score: contributor_count * 3}（仅 contributors 路径 repo 才有高值）；
 * - list_commits：{full_name, score: total_commits * 2}（仅 commits 路径 repo 才有高值）。
 */
export function createAdversarialGithubTools(): RuntimeTool[] {
  const byId = new Map(githubTools.map((spec) => [spec.id, spec]));
  const specOf = (id: string): ToolSpec => {
    const spec = byId.get(id);
    if (!spec) throw new Error(`mock: 未注册的工具 ${id}`);
    return spec;
  };
  const byName = new Map(ADVERSARIAL_REPOS.map((row) => [row.full_name, row]));
  const pick = (args: unknown): AdversarialRepoRow => {
    const fullName = String((args as Record<string, unknown>).full_name ?? "");
    return byName.get(fullName) ?? { full_name: fullName, stars: 0, forks: 0, language: "TypeScript", contributor_count: 0, total_commits: 0 };
  };
  return [
    {
      spec: specOf("github.search_repositories"),
      execute: async (args) => {
        const limit = Number((args as Record<string, unknown>).limit ?? ADVERSARIAL_REPOS.length);
        return ADVERSARIAL_REPOS.slice(0, limit).map((row) => ({ full_name: row.full_name }));
      },
    },
    {
      spec: specOf("github.get_repository"),
      execute: async (args) => {
        const row = pick(args);
        return { full_name: row.full_name, forks: row.forks, stars: row.stars, language: row.language };
      },
    },
    {
      spec: specOf("github.get_contributor_stats"),
      execute: async (args) => {
        const row = pick(args);
        return { full_name: row.full_name, score: row.contributor_count * 3 };
      },
    },
    {
      spec: specOf("github.list_commits"),
      execute: async (args) => {
        const row = pick(args);
        return { full_name: row.full_name, score: row.total_commits * 2 };
      },
    },
  ];
}

export function createMockGithubTools(options: MockGithubOptions = {}): RuntimeTool[] {
  const [minDelay = 20, maxDelay = 100] = options.delayMs ?? [20, 100];
  const count = options.repositoryCount ?? 10;
  const delay = () => new Promise<void>((resolve) => setTimeout(resolve, minDelay + Math.random() * (maxDelay - minDelay)));
  const byId = new Map(githubTools.map((spec) => [spec.id, spec]));
  const specOf = (id: string): RuntimeTool["spec"] => {
    const spec = byId.get(id);
    if (!spec) throw new Error(`mock: 未注册的工具 ${id}`);
    return spec;
  };

  const searchResults = Array.from({ length: count }, (_, i) => ({
    full_name: `mock/org-repo-${i}`,
    stars: 500 - i * 17,
    archived: i % 4 === 0,
    pushed_at: new Date(Date.now() - i * 86_400_000).toISOString(),
    language: "TypeScript",
    // 注意：search 刻意不含 forks —— R4c 的"语义依赖"要求答案必须经过
    // get_repository（forks 只有 get_repository 返回）。
  }));

  return [
    {
      spec: specOf("github.search_repositories"),
      execute: async () => searchResults,
    },
    {
      spec: specOf("github.get_repository"),
      execute: async (args) => {
        await delay();
        return {
          full_name: String((args as Record<string, unknown>).full_name ?? ""),
          stars: 100,
          forks: 200,
          archived: false,
          language: "TypeScript",
        };
      },
    },
    {
      spec: specOf("github.get_languages"),
      execute: async () => {
        await delay();
        return { TypeScript: 0.7, JavaScript: 0.3 };
      },
    },
    {
      spec: specOf("github.list_contributors"),
      execute: async () => {
        await delay();
        return [{ login: "mock-user", contributions: 42 }];
      },
    },
    {
      spec: specOf("github.get_contributor_stats"),
      execute: async (args) => {
        await delay();
        return {
          full_name: String((args as Record<string, unknown>).full_name ?? ""),
          contributor_count: 3,
          total_contributions: 120,
        };
      },
    },
    {
      spec: specOf("github.list_commits"),
      execute: async (args) => {
        await delay();
        return {
          full_name: String((args as Record<string, unknown>).full_name ?? ""),
          total_commits: 456,
          latest_commit_at: "2026-07-01T00:00:00Z",
        };
      },
    },
  ];
}

/**
 * R3 跨域 mock 工具（spec + execute）：
 * - crm.search_customers / crm.get_customer：单字段**异名**绑定（id → customer_id）；
 * - users.list_users / email.prepare：多字段绑定（email/name → to/name）。
 */
export const mockDomainToolSpecs: readonly ToolSpec[] = [
  {
    id: "crm.search_customers",
    label: "Search CRM customers",
    description: "按条件搜索客户，返回客户列表。",
    outputKind: "list<Customer>",
    parameters: [{ key: "limit", kind: "int" }],
  },
  {
    id: "crm.get_customer",
    label: "Get a customer",
    description: "按 customer_id 获取单个客户详情。",
    outputKind: "Customer",
    parameters: [{ key: "customer_id", kind: "string", required: true }],
  },
  {
    id: "users.list_users",
    label: "List users",
    description: "返回用户列表。",
    outputKind: "list<User>",
    parameters: [],
  },
  {
    id: "email.prepare",
    label: "Prepare an email",
    description: "构造一封邮件（收件人 + 姓名）。",
    outputKind: "Email",
    parameters: [
      { key: "to", kind: "string", required: true },
      { key: "name", kind: "string", required: true },
    ],
  },
];

export function createMockDomainTools(): RuntimeTool[] {
  const customers = Array.from({ length: 6 }, (_, i) => ({ id: `cust-${i + 1}`, name: `Customer ${i + 1}` }));
  const users = Array.from({ length: 6 }, (_, i) => ({ id: `user-${i + 1}`, email: `user${i + 1}@example.com`, name: `User ${i + 1}` }));
  return [
    { spec: mockDomainToolSpecs[0] as ToolSpec, execute: async () => customers },
    { spec: mockDomainToolSpecs[1] as ToolSpec, execute: async (args) => customers.find((c) => c.id === (args as Record<string, unknown>).customer_id) ?? customers[0] },
    { spec: mockDomainToolSpecs[2] as ToolSpec, execute: async () => users },
    {
      spec: mockDomainToolSpecs[3] as ToolSpec,
      execute: async (args) => ({ to: (args as Record<string, unknown>).to, name: (args as Record<string, unknown>).name }),
    },
  ];
}
