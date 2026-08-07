/**
 * Tool registry：DSL 可调用的外部工具声明。
 *
 * 第一版只有 4 个 GitHub 只读工具（read-only），只描述签名（参数名 /
 * 类型 / 必填），真实 API 调用在后续阶段接入。编译器据此做
 * `unknown_parameter` / `config_type_mismatch` 校验——这是从 canvas 阶段
 * 验证过的经验（LLM 会幻觉合理参数名，编译期拒绝最可靠）。
 */

export interface ToolParameterSpec {
  key: string;
  kind: "string" | "int" | "number" | "boolean" | "object";
  required?: boolean;
}

export interface ToolSpec {
  id: string;
  label: string;
  description?: string;
  outputKind: string;
  parameters: ToolParameterSpec[];
}

export const githubTools: readonly ToolSpec[] = [
  {
    id: "github.search_repositories",
    label: "Search GitHub repositories",
    description: "按查询条件搜索仓库，返回仓库摘要列表。",
    outputKind: "list<RepositorySummary>",
    parameters: [
      { key: "query", kind: "string", required: true },
      { key: "limit", kind: "int" },
    ],
  },
  {
    id: "github.get_repository",
    label: "Get a repository",
    description: "获取单个仓库的详细信息。",
    outputKind: "Repository",
    parameters: [{ key: "full_name", kind: "string", required: true }],
  },
  {
    id: "github.get_languages",
    label: "Get repository languages",
    description: "获取仓库语言构成（字节占比）。",
    outputKind: "object",
    parameters: [{ key: "full_name", kind: "string", required: true }],
  },
  {
    id: "github.list_contributors",
    label: "List repository contributors",
    description: "获取仓库贡献者列表。",
    outputKind: "list<Contributor>",
    parameters: [
      { key: "full_name", kind: "string", required: true },
      { key: "per_page", kind: "int" },
    ],
  },
  {
    id: "github.get_contributor_stats",
    label: "Get repository contributor stats",
    description: "获取仓库贡献者统计（贡献者人数与总贡献量）。R4d 阶段工具：贡献者数据只在 get_contributor_stats 返回。",
    outputKind: "ContributorStats",
    parameters: [{ key: "full_name", kind: "string", required: true }],
  },
  {
    id: "github.list_commits",
    label: "List repository commits",
    description: "获取仓库提交统计（总提交数与最近提交时间）。R4d 阶段工具：提交数据只在 list_commits 返回。",
    outputKind: "CommitStats",
    parameters: [
      { key: "full_name", kind: "string", required: true },
      { key: "per_page", kind: "int" },
    ],
  },
];
