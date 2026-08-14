import type { ParsedStatement } from "../../language/ast.js";
import type { DslDiagnostic } from "../../language/diagnostics.js";
import type { ToolCatalog } from "../../tools/registry.js";
import type { ExecutionNode } from "../ir.js";
/**
 * concat（R5 review 新增）：真正的列表拼接。
 * `concat(<source1>, <source2>, ...≥2)` — 位置参数全部是源数组（数量不定），
 * 按顺序拼接成一个大数组，元素原样保留，不做任何字段合并。
 *
 * 与 merge_by_key（join 节点）的分工：concat 用于"把两段列表接在一起"，
 * merge_by_key 用于"给每条记录附加另一批数据的字段"——两者语义完全不同，
 * 各自有明确的关键字，模型不再需要把列表拼接硬塞进 join。
 */
export declare function buildConcatNode(statement: ParsedStatement, _options: {
    tools?: ToolCatalog;
}, defined: ReadonlySet<string>, diagnostics: DslDiagnostic[]): ExecutionNode | undefined;
