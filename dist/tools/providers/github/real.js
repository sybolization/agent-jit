import { githubTools } from "./contracts.js";
const GITHUB_API_BASE = "https://api.github.com";
export function createRealGithubTools(options = {}) {
    const token = options.token ?? process.env.GITHUB_TOKEN;
    const fetchFn = options.fetch ?? globalThis.fetch;
    const baseUrl = options.baseUrl ?? GITHUB_API_BASE;
    if (!token) {
        throw new Error("缺少 GITHUB_TOKEN（请在 .env 中配置 fine-grained PAT，只读公开仓库即可）");
    }
    const headers = {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "agent-jit",
    };
    const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const retryAttempts = Math.max(0, options.retryAttempts ?? 2);
    const maxRetryWaitMs = options.maxRetryWaitMs ?? 15_000;
    async function getJson(path) {
        return (await getJsonWithMeta(path)).data;
    }
    /** 同 getJson，但额外返回响应头（list_commits 需要 Link 头解析总页数）。 */
    async function getJsonWithMeta(path) {
        let lastError;
        for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
            const response = await fetchFn(`${baseUrl}${path}`, { headers, signal: AbortSignal.timeout(15_000) });
            if (response.ok) {
                return { data: (await response.json()), headers: response.headers };
            }
            const remaining = response.headers.get("x-ratelimit-remaining");
            const reset = Number(response.headers.get("x-ratelimit-reset") ?? "0");
            if (response.status === 403 || response.status === 429) {
                lastError = new Error(`GitHub rate limit（HTTP ${response.status}，remaining=${remaining ?? "?"}` +
                    (reset ? `，reset=${new Date(reset * 1000).toISOString()}` : "") + "）");
                // 有界等待：reset 远在未来（如次级限流）时不挂死，等满 maxRetryWaitMs 后重试
                const waitMs = Math.min(Math.max(0, reset * 1000 - Date.now()) + 1000, maxRetryWaitMs);
                await sleep(waitMs);
                continue;
            }
            if (response.status === 404) {
                throw new Error(`GitHub 404：${path}（资源不存在或无权访问）`);
            }
            throw new Error(`GitHub API HTTP ${response.status}：${path}`);
        }
        throw lastError ?? new Error(`GitHub API 请求失败：${path}`);
    }
    const byId = new Map(githubTools.map((tool) => [tool.id, tool]));
    const specOf = (id) => {
        const spec = byId.get(id);
        if (!spec)
            throw new Error(`adapter: 未注册的工具 ${id}`);
        return spec;
    };
    const clampPerPage = (value, fallback) => Math.min(Math.max(1, Number(value) || fallback), 100);
    /** full_name（owner/repo）拆成路径两段；编码斜杠（%2F）在 /repos 端点为 404，必须分开传 */
    const repoPath = (fullName) => {
        const [owner, repo] = fullName.split("/");
        return `/repos/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(repo ?? "")}`;
    };
    return [
        {
            ...specOf("github.search_repositories"),
            execute: async (args) => {
                const { query, limit } = args;
                const data = await getJson(`/search/repositories?q=${encodeURIComponent(query ?? "")}&per_page=${clampPerPage(limit, 10)}&sort=stars`);
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
            ...specOf("github.get_repository"),
            execute: async (args) => {
                const { full_name } = args;
                const data = await getJson(repoPath(full_name ?? ""));
                return {
                    full_name: data.full_name,
                    stars: data.stargazers_count,
                    forks: data.forks_count,
                    archived: data.archived,
                    language: data.language ?? "Unknown",
                };
            },
        },
        {
            ...specOf("github.get_languages"),
            execute: async (args) => {
                const { full_name } = args;
                return getJson(repoPath(full_name ?? "") + "/languages");
            },
        },
        {
            ...specOf("github.list_contributors"),
            execute: async (args) => {
                const { full_name, per_page } = args;
                const data = await getJson(repoPath(full_name ?? "") + `/contributors?per_page=${clampPerPage(per_page, 30)}`);
                return data.map((item) => ({ login: item.login, contributions: item.contributions }));
            },
        },
        {
            ...specOf("github.get_contributor_stats"),
            execute: async (args) => {
                const { full_name } = args;
                // 只读前 100 位贡献者的统计快照（确定性，够作排序依据）
                const data = await getJson(repoPath(full_name ?? "") + "/contributors?per_page=100");
                return {
                    full_name: full_name ?? "",
                    contributor_count: data.length,
                    total_contributions: data.reduce((sum, item) => sum + item.contributions, 0),
                };
            },
        },
        {
            ...specOf("github.list_commits"),
            execute: async (args) => {
                const { full_name, per_page } = args;
                // per_page=1：只要最新一条；Link 头 rel="last" 的页号即总提交数（一次请求拿到总数）
                const { data, headers } = await getJsonWithMeta(repoPath(full_name ?? "") + `/commits?per_page=${clampPerPage(per_page, 1)}`);
                const lastPage = /page=(\d+)>;\s*rel="last"/.exec(headers.get("link") ?? "");
                return {
                    full_name: full_name ?? "",
                    total_commits: lastPage ? Number(lastPage[1]) : data.length,
                    latest_commit_at: data[0]?.commit?.committer?.date ?? null,
                };
            },
        },
    ];
}
