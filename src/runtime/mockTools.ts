import { githubTools } from "../compiler/registry.js";
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
