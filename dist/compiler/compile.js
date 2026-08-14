import { Value } from "typebox/value";
import { Parser } from "../language/parser.js";
import { tokenize } from "../language/tokenizer.js";
import { schemaViewText } from "../tools/schemaView.js";
import { ExecutionGraphSchema, } from "./ir.js";
import { compareNodes, fieldViewOf, nodeElementSchema, nodeValueView, projectElementSchema, suggestToolNames, } from "./helpers.js";
import { buildToolNode, validateMapBindings } from "./toolCall.js";
import { buildComputeNode } from "./builtins/compute.js";
import { buildCollectNode } from "./builtins/collect.js";
import { buildConcatNode } from "./builtins/concat.js";
import { buildFilterNode } from "./builtins/filter.js";
import { buildJoinNode } from "./builtins/join.js";
import { buildMapNode } from "./builtins/map.js";
import { buildReturnNode } from "./builtins/return.js";
import { buildSelectNode } from "./builtins/select.js";
import { buildSortNode } from "./builtins/sort.js";
import { buildTakeNode } from "./builtins/take.js";
export class ExecutionDslCompileError extends Error {
    diagnostics;
    constructor(diagnostics) {
        super(diagnostics.map((item) => `L${item.line}: ${item.code}: ${item.message}`).join("\n"));
        this.name = "ExecutionDslCompileError";
        this.diagnostics = diagnostics;
    }
}
function buildNode(statement, options, defined, diagnostics) {
    if (statement.callee === "map")
        return buildMapNode(statement, options, defined, diagnostics);
    if (statement.callee === "take")
        return buildTakeNode(statement, options, defined, diagnostics);
    if (statement.callee === "filter")
        return buildFilterNode(statement, options, defined, diagnostics);
    if (statement.callee === "sort")
        return buildSortNode(statement, options, defined, diagnostics);
    if (statement.callee === "compute")
        return buildComputeNode(statement, options, defined, diagnostics);
    if (statement.callee === "select")
        return buildSelectNode(statement, options, defined, diagnostics);
    if (statement.callee === "merge_by_key" || statement.callee === "join") {
        return buildJoinNode(statement, options, defined, diagnostics);
    }
    if (statement.callee === "concat")
        return buildConcatNode(statement, options, defined, diagnostics);
    if (statement.callee === "collect")
        return buildCollectNode(statement, options, defined, diagnostics);
    if (statement.callee === "return")
        return buildReturnNode(statement, options, defined, diagnostics);
    const tool = options.tools?.get(statement.callee);
    if (!tool) {
        const suggestion = suggestToolNames(options.tools, statement.callee);
        diagnostics.push({
            line: statement.line,
            code: "unknown_tool",
            message: `未注册的工具或语言关键字：${statement.callee}`,
            suggestion: suggestion ??
                "使用已注册工具 id，或语言关键字 map / take / filter / sort / compute / select / merge_by_key / concat / collect / return",
            tool: statement.callee,
            suggestions: suggestion ? [suggestion] : [],
        });
        return undefined;
    }
    return buildToolNode(statement, tool, defined, diagnostics);
}
/** 标量 SchemaView kind 集合（投影的静态诊断：标量没有字段）。 */
const SCALAR_KINDS = new Set([
    "string",
    "integer",
    "number",
    "boolean",
    "null",
]);
/**
 * 字段投影物化器（引用预解析）：把点号引用解析成已定义节点 id。
 *
 * - 精确名优先：`defined` 含该名字（普通变量或已物化的投影 id）→ 原样返回；
 * - 无点号 → undefined（调用方按普通引用处理，undefined_reference 由 builder 报）；
 * - 有点号 → 找最长的已定义前缀，逐段物化 ProjectNode 链（`a.b.c` = project(project(a,b),c)），
 *   返回链尾 id；基名未定义 → undefined。
 *
 * 静态校验（值级视图可得时）：source 是 object 且字段不存在 → UNKNOWN_FIELD
 * （列出可用字段）；source 是 array → invalid_projection（数组不能取字段）；
 * 视图未知 / record → 跳过不误报（运行时兜底：非对象 / 字段缺失整体失败）。
 */
class ProjectMaterializer {
    defined;
    nodes;
    symbols;
    valueViews;
    diagnostics;
    constructor(defined, nodes, symbols, valueViews, diagnostics) {
        this.defined = defined;
        this.nodes = nodes;
        this.symbols = symbols;
        this.valueViews = valueViews;
        this.diagnostics = diagnostics;
    }
    /** 解析引用名 → 节点 id（物化 ProjectNode 链）；无法解析返回 undefined。 */
    resolve(name, line) {
        if (this.defined.has(name))
            return name;
        if (!name.includes("."))
            return undefined;
        const segments = name.split(".");
        if (segments.some((segment) => segment.length === 0)) {
            // `a.` / `a..b`：点号路径含空字段段，无法构成合法投影
            this.diagnostics.push({
                line,
                code: "invalid_projection",
                message: `字段投影路径“${name}”含空字段段`,
                suggestion: "投影写成 变量.字段（如 files.paths），字段名不能为空",
            });
            return undefined;
        }
        // 最长已定义前缀（从最长往下试：a.b.c → a.b → a）
        let prefixLength = segments.length - 1;
        while (prefixLength >= 1 && !this.defined.has(segments.slice(0, prefixLength).join("."))) {
            prefixLength -= 1;
        }
        if (prefixLength < 1)
            return undefined; // 基名未定义 → undefined_reference 由 builder 报
        let cursor = segments.slice(0, prefixLength).join(".");
        let view = this.valueViews.get(cursor);
        for (const field of segments.slice(prefixLength)) {
            const id = `$project.${cursor}.${field}`;
            if (id.length > 200) {
                this.diagnostics.push({
                    line,
                    code: "invalid_projection",
                    message: `字段投影路径过深：节点 id 超过 200 字符上限（当前 ${id.length}）`,
                    suggestion: "投影层级过深；先把中间结果投影成中间变量（如 mid = a.b.c），再对 mid 取字段",
                });
                return undefined;
            }
            if (this.defined.has(id)) {
                cursor = id;
                view = this.valueViews.get(id);
                continue;
            }
            const node = { id, kind: "project", source: cursor, field };
            this.nodes.push(node);
            const nextView = this.projectView(view, cursor, field, line);
            this.defined.add(id);
            this.symbols.set(id, view ? projectElementSchema(view, field) : undefined);
            this.valueViews.set(id, nextView);
            cursor = id;
            view = nextView;
        }
        return cursor;
    }
    /** 静态校验投影并返回字段的值级视图（未知 → undefined 不误报）。 */
    projectView(sourceView, sourceName, field, line) {
        if (!sourceView)
            return undefined;
        if (sourceView.kind === "array" || SCALAR_KINDS.has(sourceView.kind)) {
            this.diagnostics.push({
                line,
                code: "invalid_projection",
                message: `“${sourceName}”是${sourceView.kind === "array" ? "数组" : schemaViewText(sourceView)}，不能取字段“${field}”`,
                suggestion: sourceView.kind === "array"
                    ? "数组请用 take / map / filter 等数据流操作处理元素"
                    : "标量没有字段；直接引用变量本身（去掉 .字段）",
            });
            return undefined;
        }
        const fieldView = fieldViewOf(sourceView, field);
        if (sourceView.kind === "object" && fieldView === undefined) {
            const available = Object.keys(sourceView.properties).sort().join(", ");
            this.diagnostics.push({
                line,
                code: "UNKNOWN_FIELD",
                message: `“${sourceName}”上不存在字段“${field}”`,
                suggestion: `可用字段：${available || "（无静态声明）"}`,
                field,
                availableFields: Object.keys(sourceView.properties).sort(),
            });
        }
        return fieldView;
    }
}
/**
 * 把语句顶层 ref 参数中的点号引用重写为物化后的节点 id
 * （map 绑定调用内的 `_.字段` 引用不动——它们由 mapCallBindings 另行处理）。
 */
function rewriteStatementRefs(statement, materializer) {
    const rewriteValue = (value) => {
        if (value.kind !== "ref" || value.name === undefined)
            return value;
        const resolved = materializer.resolve(value.name, value.line);
        if (resolved === undefined || resolved === value.name)
            return value;
        return { ...value, name: resolved };
    };
    const args = statement.args.map((arg) => ({
        ...arg,
        // 嵌套调用（map 的绑定调用）内的参数不做投影解析
        value: arg.value.kind === "call" ? arg.value : rewriteValue(arg.value),
    }));
    return { ...statement, args };
}
/**
 * Compile Agent Execution DSL source into an `ExecutionGraph`.
 *
 * 硬错误（语法 / 未知工具 / 未定义引用 / 重名 / 参数幻觉）一次性抛出，
 * soft 语义留待后续阶段。产物通过 `ExecutionGraphSchema` 自校验后返回。
 */
export function compileExecutionDsl(source, options = {}) {
    const { tokens, diagnostics: tokenDiagnostics } = tokenize(source);
    const parsed = new Parser(tokens).parse();
    const diagnostics = [...tokenDiagnostics, ...parsed.diagnostics];
    const defined = new Set();
    const nodes = [];
    // REQ-5：语句名 → 元素 schema 的符号表（map 绑定字段校验的事实源）
    const symbols = new Map();
    // 值级视图符号表（project 静态字段校验的事实源）
    const valueViews = new Map();
    const materializer = new ProjectMaterializer(defined, nodes, symbols, valueViews, diagnostics);
    for (const statement of parsed.statements) {
        if (defined.has(statement.name)) {
            // return 是语言关键字（parser 中 name 占位为 "return"），第二条 return 命中重名检查时
            // 报专门诊断，而不是含糊的 duplicate_name。
            if (statement.callee === "return") {
                diagnostics.push({
                    line: statement.line,
                    code: "duplicate_return",
                    message: "程序包含多条 return 语句，只允许一条 terminal return",
                    suggestion: "删除多余的 return，保留最终输出那一条",
                });
            }
            else {
                diagnostics.push({
                    line: statement.line,
                    code: "duplicate_name",
                    message: `变量名“${statement.name}”重复定义`,
                    suggestion: "变量名必须唯一",
                });
            }
            continue;
        }
        // 引用预解析：点号引用 → 隐式 ProjectNode（先于 buildNode，builder 看到的都是已定义名）
        const rewritten = rewriteStatementRefs(statement, materializer);
        const node = buildNode(rewritten, options, defined, diagnostics);
        if (!node)
            continue;
        if (node.kind === "map") {
            validateMapBindings(node, options.tools, symbols, diagnostics, statement.line);
        }
        nodes.push(node);
        defined.add(statement.name);
        symbols.set(statement.name, nodeElementSchema(node, options.tools, symbols, valueViews));
        valueViews.set(statement.name, nodeValueView(node, options.tools, valueViews));
    }
    // 完整性校验：JIT 程序必须以恰好一条 terminal return 结束。
    // 统计已构建成节点的 return 数（为 0 含空程序）；仅在无其它编译错误时补报
    // missing_return——unknown_tool 等已 throw 时不再叠加噪声。
    const returnCount = nodes.filter((node) => node.kind === "return").length;
    if (returnCount === 0 && diagnostics.length === 0) {
        const lastStatement = parsed.statements[parsed.statements.length - 1];
        diagnostics.push({
            line: lastStatement?.line ?? 0,
            code: "missing_return",
            message: "程序缺少 return 语句：JIT 程序必须以一条 terminal return 结束",
            suggestion: "在最后追加一行：return <最终结果变量>",
        });
    }
    if (diagnostics.length > 0)
        throw new ExecutionDslCompileError(diagnostics);
    nodes.sort(compareNodes);
    const graph = { schema_version: "1", nodes };
    if (!Value.Check(ExecutionGraphSchema, graph)) {
        const error = Value.Errors(ExecutionGraphSchema, graph)[0];
        diagnostics.push({
            line: 0,
            code: "schema_invalid",
            message: error ? `编译产物未通过 ExecutionIR schema 校验：${error.message}` : "编译产物未通过 ExecutionIR schema 校验",
            suggestion: "这是编译器的内部校验失败；请重试或调整节点数量",
        });
        throw new ExecutionDslCompileError(diagnostics);
    }
    return { graph, diagnostics };
}
