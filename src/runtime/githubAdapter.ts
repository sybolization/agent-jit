import { githubTools } from "../compiler/registry.js";
import type { ToolSpec } from "../compiler/registry.js";
import type { RuntimeTool } from "./runtime.js";

/**
 * 真实 GitHub adapter（P4）：与 `githubTools` 同 spec 的执行实现，用
 * `fetch` 调 GitHub REST API（Bearer token），返回字段与 mock 对齐——
 * real / mock 可互换，不改变 IR 与 taskSpec。
 *
 * token：`process.env.GITHUB_TOKEN`（.env，已被 gitignore）。
 * fetch 可注入（测试不打真实 API）。
 */

export interface RealGithubAdapterOptions {
  token?: string;
  fetch?: typeof fetch;
  /** 测试注入用；默认 https://api.github.com */
  baseUrl?: string;
}

const GITHUB_API_BASE = "https://api.github.com";

interface SearchItem {
  full_name: string;
  stargazers_count: number;
  archived: boolean;
  pushed_at: string;
  language: string | null;
}

interface RepoResult {
  full_name: string;
  stargazers_count: number;
  archived: boolean;
  language: string | null;
}

interface Contributor {
  login: string;
  contributions: number;
}

export function createRealGithubTools(options: RealGithubAdapterOptions = {}): RuntimeTool[] {
  const token = options.token ?? process.env.GITHUB_TOKEN;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl ?? GITHUB_API_BASE;

  if (!token) {
    throw new Error("缺少 GITHUB_TOKEN（请在 .env 中配置 fine-grained PAT，只读公开仓库即可）");
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "agent-dsl-r4-experiment",
  };

  async function getJson<T>(path: string): Promise<T> {
    const response = await fetchFn(`${baseUrl}${path}`, { headers, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      const reset = Number(response.headers.get("x-ratelimit-reset") ?? "0");
      if (response.status === 403 || response.status === 429) {
        throw new Error(
          `GitHub rate limit（HTTP ${response.status}，remaining=${remaining ?? "?"}` +
            (reset ? `，reset=${new Date(reset * 1000).toISOString()}` : "") + "）",
        );
      }
      if (response.status === 404) {
        throw new Error(`GitHub 404：${path}（资源不存在或无权访问）`);
      }
      throw new Error(`GitHub API HTTP ${response.status}：${path}`);
    }
    return (await response.json()) as T;
  }

  const byId = new Map(githubTools.map((tool) => [tool.id, tool]));
  const specOf = (id: string): ToolSpec => {
    const spec = byId.get(id);
    if (!spec) throw new Error(`adapter: 未注册的工具 ${id}`);
    return spec;
  };

  const clampPerPage = (value: number | undefined, fallback: number): number =>
    Math.min(Math.max(1, Number(value) || fallback), 100);

  /** full_name（owner/repo）拆成路径两段；编码斜杠（%2F）在 /repos 端点为 404，必须分开传 */
  const repoPath = (fullName: string): string => {
    const [owner, repo] = fullName.split("/");
    return `/repos/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(repo ?? "")}`;
  };

  return [
    {
      spec: specOf("github.search_repositories"),
      execute: async (args) => {
        const { query, limit } = args as { query?: string; limit?: number };
        const data = await getJson<{ items?: SearchItem[] }>(
          `/search/repositories?q=${encodeURIComponent(query ?? "")}&per_page=${clampPerPage(limit, 10)}&sort=stars`,
        );
        return (data.items ?? []).map((item) => ({
          full_name: item.full_name,
          stars: item.stargazers_count,
          archived: item.archived,
          pushed_at: item.pushed_at,
          language: item.language ?? "Unknown",
        }));
      },
    },
    {
      spec: specOf("github.get_repository"),
      execute: async (args) => {
        const { full_name } = args as { full_name?: string };
        const data = await getJson<RepoResult>(repoPath(full_name ?? ""));
        return {
          full_name: data.full_name,
          stars: data.stargazers_count,
          archived: data.archived,
          language: data.language ?? "Unknown",
        };
      },
    },
    {
      spec: specOf("github.get_languages"),
      execute: async (args) => {
        const { full_name } = args as { full_name?: string };
        return getJson<Record<string, number>>(repoPath(full_name ?? "") + "/languages");
      },
    },
    {
      spec: specOf("github.list_contributors"),
      execute: async (args) => {
        const { full_name, per_page } = args as { full_name?: string; per_page?: number };
        const data = await getJson<Contributor[]>(
          repoPath(full_name ?? "") + `/contributors?per_page=${clampPerPage(per_page, 30)}`,
        );
        return data.map((item) => ({ login: item.login, contributions: item.contributions }));
      },
    },
  ];
}
