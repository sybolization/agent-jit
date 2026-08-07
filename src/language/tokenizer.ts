import type { DslDiagnostic } from "./diagnostics.js";
import type { Token, TokenizeResult } from "./ast.js";

/**
 * DSL 词法分析：把源码切成 token 流。纯函数、无副作用，语法诊断以
 * `DslDiagnostic` 批量返回（不抛出）。
 */
export function tokenize(source: string): TokenizeResult {
  const tokens: Token[] = [];
  const diagnostics: DslDiagnostic[] = [];
  let i = 0;
  let line = 1;

  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === "\n") {
      tokens.push({ type: "newline", value: "\n", line });
      i += 1;
      line += 1;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "#") {
      while (i < source.length && (source[i] as string) !== "\n") i += 1;
      continue;
    }
    if (ch === '"') {
      const startLine = line;
      let j = i + 1;
      let value = "";
      let closed = false;
      while (j < source.length) {
        const current = source[j] as string;
        if (current === '"') {
          closed = true;
          break;
        }
        if (current === "\n") break;
        if (current === "\\") {
          const escaped = source[j + 1];
          if (escaped === "n") value += "\n";
          else if (escaped === "t") value += "\t";
          else if (escaped === '"') value += '"';
          else if (escaped === "\\") value += "\\";
          else value += escaped ?? "";
          j += 2;
          continue;
        }
        value += current;
        j += 1;
      }
      if (!closed) {
        diagnostics.push({
          line: startLine,
          code: "syntax",
          message: `未闭合的字符串：${ch}${value}`.slice(0, 200),
          suggestion: "用双引号包裹字符串，并确保在换行前闭合",
        });
        i = j + 1;
        continue;
      }
      tokens.push({ type: "string", value, line: startLine });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const startLine = line;
      let j = i;
      // 标识符允许点号命名空间（如 github.search_repositories）。
      while (j < source.length && /[A-Za-z0-9_.]/.test(source[j] as string)) j += 1;
      tokens.push({ type: "ident", value: source.slice(i, j), line: startLine });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "-" && /[0-9]/.test(source[i + 1] ?? ""))) {
      const startLine = line;
      let j = i;
      if ((source[j] as string) === "-") j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      if ((source[j] as string) === "." && /[0-9]/.test(source[j + 1] ?? "")) {
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ type: "number", value: source.slice(i, j), line: startLine });
      i = j;
      continue;
    }
    if ("=(),[]:".includes(ch)) {
      tokens.push({ type: "symbol", value: ch, line });
      i += 1;
      continue;
    }
    diagnostics.push({
      line,
      code: "syntax",
      message: `无法识别的字符：${ch}`,
      suggestion: "只允许标识符（含点号命名空间）、数字、双引号字符串、注释（#）和符号 = ( ) , [ ] :",
    });
    i += 1;
  }
  tokens.push({ type: "eof", value: "", line });
  return { tokens, diagnostics };
}
