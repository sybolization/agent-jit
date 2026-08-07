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
