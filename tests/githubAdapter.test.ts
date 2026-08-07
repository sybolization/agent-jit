import { describe, expect, test } from "vitest";

import { createRealGithubTools } from "../src/runtime/githubAdapter.js";

/** mock fetch：记录调用，返回预设响应，不打真实 API。 */
function makeFetch(results: Response[]): { fn: typeof fetch; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const result = results.shift();
    if (!result) throw new Error("mock fetch: 响应用尽");
    return result;
  }) as typeof fetch;
  return { fn, calls };
}

const jsonResponse = (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });

describe("createRealGithubTools — 真实 GitHub adapter（mock fetch）", () => {
  test("search_repositories：URL（q 编码/per_page/sort）+ token 头 + 字段映射", async () => {
    const { fn, calls } = makeFetch([
      jsonResponse({
        items: [
          { full_name: "owner/repo-a", stargazers_count: 42, archived: false, pushed_at: "2026-01-01T00:00:00Z", language: "TypeScript" },
          { full_name: "owner/repo-b", stargazers_count: 7, archived: true, pushed_at: "2025-06-01T00:00:00Z", language: null },
        ],
      }),
    ]);
    const tools = createRealGithubTools({ token: "test-token", fetch: fn, baseUrl: "https://api.test" });
    const result = await tools.find((tool) => tool.spec.id === "github.search_repositories")!.execute({ query: "agent framework", limit: 10 });

    expect(calls[0]!.url).toBe("https://api.test/search/repositories?q=agent%20framework&per_page=10&sort=stars");
    expect(calls[0]!.headers.authorization).toBe("Bearer test-token");
    expect(calls[0]!.headers.accept).toBe("application/vnd.github+json");
    expect(calls[0]!.headers["x-github-api-version"]).toBe("2022-11-28");
    expect(result).toEqual([
      { full_name: "owner/repo-a", stars: 42, archived: false, pushed_at: "2026-01-01T00:00:00Z", language: "TypeScript" },
      { full_name: "owner/repo-b", stars: 7, archived: true, pushed_at: "2025-06-01T00:00:00Z", language: "Unknown" },
    ]);
  });

  test("get_repository：全名编码为 %2F，字段映射与 mock 对齐", async () => {
    const { fn, calls } = makeFetch([
      jsonResponse({ full_name: "owner/repo", stargazers_count: 99, archived: false, language: "Python" }),
    ]);
    const tools = createRealGithubTools({ token: "test-token", fetch: fn, baseUrl: "https://api.test" });
    const result = await tools.find((tool) => tool.spec.id === "github.get_repository")!.execute({ full_name: "owner/repo" });

    expect(calls[0]!.url).toBe("https://api.test/repos/owner/repo");
    expect(result).toEqual({ full_name: "owner/repo", stars: 99, archived: false, language: "Python" });
  });

  test("get_languages：原样返回语言对象", async () => {
    const { fn } = makeFetch([jsonResponse({ TypeScript: 1200, JavaScript: 300 })]);
    const tools = createRealGithubTools({ token: "test-token", fetch: fn, baseUrl: "https://api.test" });
    const result = await tools.find((tool) => tool.spec.id === "github.get_languages")!.execute({ full_name: "owner/repo" });
    expect(result).toEqual({ TypeScript: 1200, JavaScript: 300 });
  });

  test("list_contributors：per_page 默认 30，映射 login/contributions", async () => {
    const { fn, calls } = makeFetch([jsonResponse([{ login: "alice", contributions: 50 }])]);
    const tools = createRealGithubTools({ token: "test-token", fetch: fn, baseUrl: "https://api.test" });
    const result = await tools.find((tool) => tool.spec.id === "github.list_contributors")!.execute({ full_name: "owner/repo" });
    expect(calls[0]!.url).toBe("https://api.test/repos/owner/repo/contributors?per_page=30");
    expect(result).toEqual([{ login: "alice", contributions: 50 }]);
  });

  test("429/403：抛 rate limit 错误（含 remaining/reset）", async () => {
    const { fn } = makeFetch([
      jsonResponse({ message: "rate limit" }, { status: 429, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" } }),
    ]);
    const tools = createRealGithubTools({ token: "test-token", fetch: fn, baseUrl: "https://api.test" });
    await expect(tools.find((tool) => tool.spec.id === "github.get_repository")!.execute({ full_name: "a/b" })).rejects.toThrow(/rate limit/);
  });

  test("404：抛资源不存在错误", async () => {
    const { fn } = makeFetch([jsonResponse({ message: "Not Found" }, { status: 404 })]);
    const tools = createRealGithubTools({ token: "test-token", fetch: fn, baseUrl: "https://api.test" });
    await expect(tools.find((tool) => tool.spec.id === "github.get_repository")!.execute({ full_name: "ghost/repo" })).rejects.toThrow(/404/);
  });

  test("缺 token：创建时报错", () => {
    expect(() => createRealGithubTools({ token: "", fetch: (async () => new Response()) as typeof fetch })).toThrow(/GITHUB_TOKEN/);
  });
});
