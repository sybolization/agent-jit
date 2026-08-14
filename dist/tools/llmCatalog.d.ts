import type { ToolCatalog } from "./registry.js";
export interface RenderToolContractsOptions {
    /** 只渲染这些 id 的工具；缺省渲染全部。提供时保持 ids 给出的顺序 */
    ids?: readonly string[];
    /** 与 pi-ai 工具定义的命名保持一致（如把 "github.search_repositories" 映射为 "github_search_repositories"） */
    nameTransform?: (id: string) => string;
    /** 覆盖目录标题行（如 "# Requested Tool Contracts"）；缺省用默认标题 */
    header?: string;
}
/** 渲染紧凑工具目录（可选子集）。nameTransform 用于与 pi-ai 工具定义的命名保持一致。 */
export declare function renderToolContracts(catalog: ToolCatalog, options?: RenderToolContractsOptions): string;
/** 渲染完整工具目录（ToolRegistry 的 LLM Catalog 消费者入口；子集见 renderToolContracts）。 */
export declare function renderCompactToolCatalog(catalog: ToolCatalog, nameTransform?: (id: string) => string): string;
