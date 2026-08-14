import type { RegisteredTool } from "../../definition.js";
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
    /** 测试注入用：限流重试的等待函数（默认 setTimeout），测试可传空函数避免真实等待 */
    sleep?: (ms: number) => Promise<void>;
    /** 限流重试次数（默认 2：最多 1 次初始 + 2 次重试） */
    retryAttempts?: number;
    /** 单次限流等待上限（ms，默认 15s），reset 远在未来时避免挂死 */
    maxRetryWaitMs?: number;
}
export declare function createRealGithubTools(options?: RealGithubAdapterOptions): RegisteredTool[];
