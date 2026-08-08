/**
 * 语言前端共用的诊断类型。
 *
 * `code` 故意用 `string` 而非封闭 union：前端不关心具体语义域，
 * 由各编译后端用常量收紧。
 */
export interface DslDiagnostic {
  line: number;
  code: string;
  message: string;
  suggestion?: string;
}
