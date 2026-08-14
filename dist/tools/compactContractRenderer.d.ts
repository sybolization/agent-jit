import type { ToolCatalog } from "./registry.js";
/**
 * 渲染紧凑输出清单：`<canonical-id> -> <形状>`，一行一个工具。
 * ids 缺省时按 id 字典序输出全部工具；提供时保持给定顺序（去重）。
 * 只返回形状行（不含标题段）——标题由调用方（如 treatment 提示词的
 * `## Output manifest` 段）统一添加，保持 manifest 本身无任何 `# ` 行。
 */
export declare function renderCompactManifest(catalog: ToolCatalog, ids?: readonly string[]): string;
