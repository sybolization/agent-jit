import type { ToolContract } from "./definition.js";
import type { ToolCatalog } from "./registry.js";
/**
 * Schema 推导的 Composition Hints：自动告诉模型"哪些 output field 可以喂给哪些 input"。
 *
 * 只提供 **type-derived 局部兼容连接**（output 字段名 == 目标 input 参数名 + 类型兼容），
 * 绝不输出任务计划或端到端拓扑——模型仍自行决定如何组合这些能力。
 *
 * 规则（第一版非常保守）：
 * - 输出为 object / array<object>（array 取元素对象）；
 * - 输出字段为叶子类型（string / integer / number / boolean）；
 * - 字段名等于目标工具的 input 参数名；
 * - SchemaView 类型兼容（同 kind；integer ↔ number 互通，integer 是 number 的子集）；
 * - 排除同一工具自引用；去重；确定性排序。
 */
export interface CompositionHint {
    /** 输出方工具 canonical id（如 github.search_repositories） */
    fromTool: string;
    /** 输出字段名（如 full_name） */
    fromField: string;
    /** 输出字段来自数组元素（渲染为 tool[].field）还是单对象（tool.field） */
    fromArray: boolean;
    /** 输入方工具 canonical id（如 github.get_repository） */
    toTool: string;
    /** 输入参数名（与 fromField 同名） */
    toParam: string;
    /** 字段类型文本（string / integer / number / boolean） */
    type: string;
}
/**
 * 确定性推导局部兼容连接。只使用传入的 contracts 子集（调用方传"本次 describe 请求的工具"）。
 */
export declare function deriveCompositionHints(contracts: readonly ToolContract[]): CompositionHint[];
/**
 * 渲染 `## Compatible bindings` 段（供 jit_describe_tools 追加；无 hint 时返回空串）。
 * 数组元素字段渲染为 `tool[].field`，单对象字段渲染为 `tool.field`。
 */
export declare function renderCompositionBindings(catalog: ToolCatalog, ids: readonly string[]): string;
