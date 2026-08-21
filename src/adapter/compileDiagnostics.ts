import type { ExecutionDslCompileError } from "../compiler/compile.js";
import type { DslDiagnostic } from "../language/diagnostics.js";

type JitDiagnosticCode =
  | "UNKNOWN_TOOL"
  | "UNKNOWN_ARGUMENT"
  | "UNKNOWN_OUTPUT_FIELD"
  | "TYPE_MISMATCH";

interface JitDiagnostic {
  code: JitDiagnosticCode;
  line: number;
  tool?: string;
  argument?: string;
  field?: string;
  availableFields?: readonly string[];
  legalArguments?: readonly string[];
  suggestions?: readonly string[];
  expected?: string;
  actual?: string;
}

const FIX_HINTS: Record<string, string> = {
  unknown_tool:
    "期望：已注册业务工具 id，或语言关键字 map / take / filter / sort / compute / select / merge_by_key / concat / return",
  unknown_parameter:
    "期望：只使用该工具契约声明的参数名（见 active tool 的 DSL signature），不得自创参数",
  UNKNOWN_FIELD:
    "期望：绑定字段 _.字段 必须来自上游工具输出 schema（见契约的输出字段）",
  MAP_BINDING_REF_INVALID:
    "期望：绑定值必须形如 _.字段（引用当前元素），不能是字面量或外部变量",
  undefined_reference: "期望：被引用的变量必须在该语句之前定义（不允许前向引用）",
  duplicate_name: "期望：变量名必须唯一，改名后重新定义",
  duplicate_argument: "期望：每个参数只能赋值一次",
  invalid_reference: "期望：该参数必须是先前定义的变量引用（或字面量，见具体说明）",
  config_type_mismatch: "期望：字面量类型/形状必须与契约声明的参数类型一致",
  expression_invalid:
    "期望：compute 表达式 = 字段引用 + 数字 + 四则运算 + 括号；select 谓词 = 顶层比较（> >= < <= == !=）",
  TOO_MANY_POSITIONAL_ARGS:
    "期望：位置参数数量不超过该关键字定义的槽位（顺序见提示）",
  syntax: "期望：语句形如 <变量> = <调用>(<参数>, ...)，检查标点、引号与参数形式",
  missing_return:
    "期望：程序必须包含且仅包含一条 terminal return（最后一行 return <变量>，变量必须已定义）",
  duplicate_return: "期望：只保留一条 return（最终输出那一条），删除其余 return",
};

const MAPPED_COMPILE_CODES: Record<string, JitDiagnosticCode> = {
  unknown_tool: "UNKNOWN_TOOL",
  unknown_parameter: "UNKNOWN_ARGUMENT",
  UNKNOWN_FIELD: "UNKNOWN_OUTPUT_FIELD",
  config_type_mismatch: "TYPE_MISMATCH",
};

function splitDiagnostics(diagnostics: readonly DslDiagnostic[]): {
  mapped: JitDiagnostic[];
  unmapped: DslDiagnostic[];
} {
  const mapped: JitDiagnostic[] = [];
  const unmapped: DslDiagnostic[] = [];
  for (const item of diagnostics) {
    const code = MAPPED_COMPILE_CODES[item.code];
    if (code === undefined) {
      unmapped.push(item);
      continue;
    }
    mapped.push({
      code,
      line: item.line,
      tool: item.tool,
      argument: item.argument,
      field: item.field,
      availableFields: item.availableFields,
      legalArguments: item.legalArguments,
      suggestions: item.suggestions,
      expected: item.expected,
      actual: item.actual,
    });
  }
  return { mapped, unmapped };
}

function diagnosticProseLine(item: DslDiagnostic): string {
  const hint = FIX_HINTS[item.code];
  const parts = [`L${item.line}: ${item.code}: ${item.message}`];
  if (item.suggestion) parts.push(`（${item.suggestion}）`);
  if (hint) parts.push(`——${hint}`);
  return parts.join("");
}

function renderMappedDiagnosticLine(item: JitDiagnostic): string {
  const prefix = `L${item.line}`;
  switch (item.code) {
    case "UNKNOWN_OUTPUT_FIELD": {
      const target = item.field !== undefined ? `_.${item.field}` : "_";
      const available = item.availableFields?.length
        ? `[${item.availableFields.join(", ")}]`
        : "[]";
      return `${prefix} UNKNOWN_OUTPUT_FIELD: ${target} → 可用字段: ${available}`;
    }
    case "UNKNOWN_ARGUMENT": {
      const legal = item.legalArguments?.length
        ? `[${item.legalArguments.join(", ")}]`
        : "[]";
      return `${prefix} UNKNOWN_ARGUMENT: ${item.argument ?? ""} → 合法参数: ${legal}`;
    }
    case "UNKNOWN_TOOL": {
      const suggestions = item.suggestions ? item.suggestions.slice(0, 2) : [];
      const list = suggestions.length ? `[${suggestions.join(", ")}]` : "[]";
      return `${prefix} UNKNOWN_TOOL: ${item.tool ?? ""} → 建议: ${list}`;
    }
    case "TYPE_MISMATCH": {
      const target = item.argument ?? item.field ?? "";
      return `${prefix} TYPE_MISMATCH: ${target} 期望 ${item.expected ?? "unknown"}，实际 ${item.actual ?? "unknown"}`;
    }
  }
}

/** Exact legacy JIT compile-error projection, kept host-neutral. */
export function renderHarnessCompileFailure(error: ExecutionDslCompileError): string {
  const { mapped, unmapped } = splitDiagnostics(error.diagnostics);
  return [
    "编译失败：",
    ...mapped.map(renderMappedDiagnosticLine),
    ...unmapped.map(diagnosticProseLine),
    "请根据上述诊断修正 DSL 后再次调用 jit_execute_program 重新提交。",
  ].join("\n");
}
