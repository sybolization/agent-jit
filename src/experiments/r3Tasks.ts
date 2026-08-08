/**
 * R3 任务集：map data binding 三臂实验的 5 个任务。
 *
 * binding 形态覆盖：
 * - 任务 1-3：GitHub 单字段同名（full_name → full_name）；
 * - 任务 4：mock CRM 单字段**异名**（id → customer_id，测命名映射）；
 * - 任务 5：mock 用户**多字段**（email/name → to/name，测 A 臂 key= 的扩展性）。
 */
import { githubTools } from "../tools/providers/github/contracts.js";
import type { ToolContract } from "../tools/definition.js";
import { mockDomainToolSpecs } from "../tools/providers/domain/mock.js";
import type { TaskSpec } from "./taskSpec.js";

export interface R3Task {
  id: number;
  name: string;
  /** 给模型的任务描述（natural language） */
  prompt: string;
  /** 期望程序（TaskSpec + bindings） */
  spec: TaskSpec;
  /** 该任务对模型可见的工具目录 */
  tools: readonly ToolContract[];
}

const takeLine = "最后截取前 3 个作为最终结果并返回（return）。";

const GITHUB_TOOLS_1 = githubTools.filter((tool) =>
  ["github.search_repositories", "github.get_repository"].includes(tool.id),
);
const GITHUB_TOOLS_2 = githubTools.filter((tool) =>
  ["github.search_repositories", "github.get_languages"].includes(tool.id),
);
const GITHUB_TOOLS_3 = githubTools.filter((tool) =>
  ["github.search_repositories", "github.list_contributors"].includes(tool.id),
);
const CRM_TOOLS = mockDomainToolSpecs.filter((tool) =>
  ["crm.search_customers", "crm.get_customer"].includes(tool.id),
);
const USER_TOOLS = mockDomainToolSpecs.filter((tool) =>
  ["users.list_users", "email.prepare"].includes(tool.id),
);

export const R3_TASKS: readonly R3Task[] = [
  {
    id: 1,
    name: "repo-details",
    prompt:
      "请用 Agent Execution DSL 编写程序：搜索 GitHub 上活跃的 TypeScript agent 框架仓库（query 用 " +
      '"agent framework language:typescript"），取前 10 个，然后对每个仓库获取其详细信息（每个仓库元素的字段 full_name 要传给 github.get_repository 的 full_name 参数）。' +
      takeLine,
    spec: {
      query: "agent framework",
      queryTokens: ["agent framework", "language:typescript"],
      limit: 10,
      takeCount: 3,
      bindings: { full_name: "full_name" },
    },
    tools: GITHUB_TOOLS_1,
  },
  {
    id: 2,
    name: "repo-languages",
    prompt:
      "请用 Agent Execution DSL 编写程序：搜索 GitHub 上活跃的 TypeScript agent 框架仓库（query 用 " +
      '"agent framework language:typescript"），取前 10 个，然后对每个仓库获取其语言构成（每个仓库元素的字段 full_name 要传给 github.get_languages 的 full_name 参数）。' +
      takeLine,
    spec: {
      query: "agent framework",
      queryTokens: ["agent framework", "language:typescript"],
      limit: 10,
      takeCount: 3,
      bindings: { full_name: "full_name" },
    },
    tools: GITHUB_TOOLS_2,
  },
  {
    id: 3,
    name: "repo-contributors",
    prompt:
      "请用 Agent Execution DSL 编写程序：搜索 GitHub 上活跃的 TypeScript agent 框架仓库（query 用 " +
      '"agent framework language:typescript"），取前 10 个，然后对每个仓库获取其贡献者列表（每个仓库元素的字段 full_name 要传给 github.list_contributors 的 full_name 参数）。' +
      takeLine,
    spec: {
      query: "agent framework",
      queryTokens: ["agent framework", "language:typescript"],
      limit: 10,
      takeCount: 3,
      bindings: { full_name: "full_name" },
    },
    tools: GITHUB_TOOLS_3,
  },
  {
    id: 4,
    name: "customer-detail",
    prompt:
      "请用 Agent Execution DSL 编写程序：调用 crm.search_customers 搜索客户列表（取前 10 个），" +
      "然后对每个客户获取其详情（每个客户元素的字段 id 要传给 crm.get_customer 的 customer_id 参数）。" +
      takeLine,
    spec: {
      sourceTool: "crm.search_customers",
      limit: 10,
      takeCount: 3,
      bindings: { customer_id: "id" },
    },
    tools: CRM_TOOLS,
  },
  {
    id: 5,
    name: "user-emails",
    prompt:
      "请用 Agent Execution DSL 编写程序：调用 users.list_users 列出用户，" +
      "然后对每个用户构造一封邮件（每个用户元素的字段 email 要传给 email.prepare 的 to 参数，字段 name 要传给 email.prepare 的 name 参数）。" +
      takeLine,
    spec: {
      sourceTool: "users.list_users",
      takeCount: 3,
      bindings: { to: "email", name: "name" },
    },
    tools: USER_TOOLS,
  },
];
