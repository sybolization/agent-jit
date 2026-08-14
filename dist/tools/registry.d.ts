import type { ToolContract } from "./definition.js";
/**
 * ToolIdResolver：canonical id 与 host alias 的无感解析。
 *
 * 名字体系（. / _ 是宿主框架与 DSL 的表示差异，不应成为模型的认知负担）：
 * - canonical id：DSL / IR / 运行时唯一事实源（github.get_repository）；
 * - host alias：宿主框架（Pi）的工具名（github_get_repository），注册时自动生成。
 *   get / resolveId 两种形式等价解析；IR 永远只写 canonical id。
 *
 * 注册时构建"所有名字 → canonical id"索引；flatten collision
 * （foo.bar_baz 与 foo_bar.baz 都变成 foo_bar_baz）**fail fast 抛错**，
 * 不允许"最后注册的覆盖前一个"。
 */
/** canonical id → host alias：github.get_repository → github_get_repository（点号 → 下划线）。 */
export declare function toolIdAlias(id: string): string;
/** Levenshtein 编辑距离（未知工具名的确定性近似匹配用）。 */
export declare function editDistance(left: string, right: string): number;
/** 未知名字的近似匹配建议（诊断 / describe 错误共用）。 */
export interface ToolIdSuggestion {
    /** host 写法（点号 → 下划线；无点号时等于 canonical） */
    alias: string;
    /** canonical id（IR / 诊断的事实源） */
    canonical: string;
}
/**
 * 三方共享的薄接口：compiler / catalog renderer / runtime 只依赖 get / all；
 * resolveId / suggestIds 是 ToolIdResolver 能力（canonical 与 host alias 无感解析）。
 */
export interface ToolCatalog {
    get(id: string): ToolContract | undefined;
    all(): readonly ToolContract[];
    /** 解析 canonical id 或 host alias → canonical id（未知返回 undefined）。 */
    resolveId(name: string): string | undefined;
    /** 未知名字的确定性近似建议（阈值内，最多 max 个；相似度太低不推荐）。 */
    suggestIds(name: string, max?: number): readonly ToolIdSuggestion[];
}
/** 工具注册表：register / get / has / all / ids。注册时构建 canonical + host alias 名索引。 */
export declare class ToolRegistry<T extends ToolContract = ToolContract> implements ToolCatalog {
    private readonly byId;
    /** 所有可用名字（canonical id + host alias）→ canonical id。 */
    private readonly nameIndex;
    constructor(definitions?: readonly T[]);
    register(definition: T): void;
    /** ToolIdResolver：canonical 或 host alias 无感解析 → canonical id（未知返回 undefined）。 */
    resolveId(name: string): string | undefined;
    get(name: string): T | undefined;
    has(name: string): boolean;
    /** canonical id → host alias（Pi 工具注册 / 渲染提交名）。 */
    hostName(id: string): string;
    /** 确定性近似建议：距离升序 + canonical id 字典序稳定排序，最多 max 个。 */
    suggestIds(name: string, max?: number): readonly ToolIdSuggestion[];
    all(): readonly T[];
    ids(): readonly string[];
}
