import { Type } from "typebox";
import { defineTool, type ToolContract } from "../../definition.js";

/**
 * GitHub 工具契约（唯一事实源，provider 层，与 compiler / runtime 解耦）。
 *
 * 6 个 GitHub 只读工具（read-only），只描述契约（inputSchema / outputSchema），
 * 真实 API 调用在 provider 层（real / mock）注册时补上 execute。编译器据此做
 * `unknown_parameter` / `config_type_mismatch` 校验——LLM 会幻觉合理参数名，
 * 编译期拒绝最可靠。
 */

export const githubTools: readonly ToolContract[] = [
  defineTool({
    id: "github.search_repositories",
    label: "Search GitHub repositories",
    description: "按查询条件搜索仓库，返回仓库摘要列表。",
    inputSchema: Type.Object(
      { query: Type.String(), limit: Type.Optional(Type.Integer()) },
      { additionalProperties: false },
    ),
    outputSchema: Type.Array(
      Type.Object(
        {
          full_name: Type.String(),
          stars: Type.Integer(),
          archived: Type.Boolean(),
          pushed_at: Type.String(),
          language: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  }),
  defineTool({
    id: "github.get_repository",
    label: "Get a repository",
    description: "获取单个仓库的详细信息。",
    inputSchema: Type.Object({ full_name: Type.String() }, { additionalProperties: false }),
    outputSchema: Type.Object(
      {
        full_name: Type.String(),
        stars: Type.Integer(),
        forks: Type.Integer(),
        archived: Type.Boolean(),
        language: Type.String(),
      },
      { additionalProperties: false },
    ),
  }),
  defineTool({
    id: "github.get_languages",
    label: "Get repository languages",
    description: "获取仓库语言构成（字节占比）。",
    inputSchema: Type.Object({ full_name: Type.String() }, { additionalProperties: false }),
    outputSchema: Type.Record(Type.String(), Type.Number()),
  }),
  defineTool({
    id: "github.list_contributors",
    label: "List repository contributors",
    description: "获取仓库贡献者列表。",
    inputSchema: Type.Object(
      { full_name: Type.String(), per_page: Type.Optional(Type.Integer()) },
      { additionalProperties: false },
    ),
    outputSchema: Type.Array(
      Type.Object(
        { login: Type.String(), contributions: Type.Integer() },
        { additionalProperties: false },
      ),
    ),
  }),
  defineTool({
    id: "github.get_contributor_stats",
    label: "Get repository contributor stats",
    description: "获取仓库贡献者统计。返回 { full_name, contributor_count, total_contributions }。",
    inputSchema: Type.Object({ full_name: Type.String() }, { additionalProperties: false }),
    outputSchema: Type.Object(
      {
        full_name: Type.String(),
        contributor_count: Type.Integer(),
        total_contributions: Type.Integer(),
      },
      { additionalProperties: false },
    ),
  }),
  defineTool({
    id: "github.list_commits",
    label: "List repository commits",
    description: "获取仓库提交统计。返回 { full_name, total_commits, latest_commit_at }。",
    inputSchema: Type.Object(
      { full_name: Type.String(), per_page: Type.Optional(Type.Integer()) },
      { additionalProperties: false },
    ),
    outputSchema: Type.Object(
      {
        full_name: Type.String(),
        total_commits: Type.Integer(),
        latest_commit_at: Type.Union([Type.String(), Type.Null()]),
      },
      { additionalProperties: false },
    ),
  }),
];
