import type { ParsedStatement } from "../../language/ast.js";
import type { DslDiagnostic } from "../../language/diagnostics.js";
import type { ToolCatalog } from "../../tools/registry.js";
import type { ExecutionNode } from "../ir.js";
/**
 * merge_by_key（R4e 遗留关键字 join 的 canonical 名称；join 保留为别名，编译产物同一节点）：
 * 多输入按 key 合并字段——语义是"给每条基准记录附加另一批数据的字段"，**不是**对称合并。
 * `merge_by_key(<base>, <source2>, ...≥2, key="<字段>")` — 位置参数全部是 source（数量不定），
 * sources[0] 为基准（base），其余按 key 匹配后附加字段（基准已有字段不覆盖）。
 *
 * 与 concat（列表拼接）的分工：需要"把两段列表接在一起"时用 concat；需要
 * "按 key 把另一批数据的字段附加到每条记录"时用 merge_by_key。
 */
export declare function buildJoinNode(statement: ParsedStatement, _options: {
    tools?: ToolCatalog;
}, defined: ReadonlySet<string>, diagnostics: DslDiagnostic[]): ExecutionNode | undefined;
