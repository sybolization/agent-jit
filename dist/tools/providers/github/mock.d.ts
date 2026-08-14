import { type RegisteredTool } from "../../definition.js";
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
export declare const ADVERSARIAL_REPOS: readonly AdversarialRepoRow[];
/**
 * R4e adversarial mock 工具：**自持契约**（不复用 githubTools，契约分离）——
 * - search：{limit 可选} → [{full_name}]（返回前 N 个仓库，按表序，忽略 query）；
 * - get_repository：{full_name 必填} → {full_name, forks, stars, language}；
 * - get_contributor_stats：{full_name 必填} → {full_name, score: contributor_count * 3}
 *   （仅 contributors 路径 repo 才有高值；score 语义见 description）；
 * - list_commits：{full_name 必填, per_page 可选} → {full_name, score: total_commits * 2}
 *   （仅 commits 路径 repo 才有高值；score 与 stats 同尺度）。
 */
export declare function createAdversarialGithubTools(): RegisteredTool[];
/**
 * R6.2 Opaque adversarial mock 工具：与 `createAdversarialGithubTools()` 共享同一份
 * `ADVERSARIAL_REPOS` 与完全相同的执行逻辑，仅 output 字段名换成无法从任务语义猜出的
 * opaque 名，字段与 transparent 一一映射（ground-truth mapping）：
 *   repo_ref = full_name；metric_x = forks；metric_y = stars；metric_z = language；
 *   aggregate_value = score。
 *
 * 约束：input schema / tool id / label 与 transparent 完全一致；description 中性化
 * （不泄露 `full_name / forks / stars / score` 等透明字段名）；output schema property
 * description 携带最小语义标签，供 compact manifest 渲染 `metric_x: integer[forks]`
 * 形态（仅 manifest 臂可见）。
 */
export declare function createOpaqueAdversarialGithubTools(): RegisteredTool[];
export declare function createMockGithubTools(options?: MockGithubOptions): RegisteredTool[];
