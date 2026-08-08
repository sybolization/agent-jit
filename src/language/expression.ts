/**
 * R4e 受限表达式（compute 字段计算 / select 谓词）——语言前端 expression 域。
 *
 * 刻意**不是**完整表达式 VM：只支持
 * - 字面量：数字、字符串、true/false/null；
 * - 字段引用：裸标识符（从当前元素取值，缺失为 undefined）；
 * - 二元运算：`+ - * /`（数值）+ 比较 `> >= < <= == !=`；
 * - 括号、一元负号。
 *
 * 拒绝函数调用、数组、字符串拼接、对象等——DSL 的 compute/select 是
 * 元素级纯函数。compiler 在编译期 parseExpr 一次并把 AST 编入 IR 节点
 * （错误在编译期暴露，repair 可修）；executor 与 benchmark oracle 共用
 * evalExpr，保证"执行语义 == oracle 语义"。
 */

export type BinaryOp = "+" | "-" | "*" | "/" | ">" | ">=" | "<" | "<=" | "==" | "!=";

export type ExprNode =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "null" }
  | { kind: "field"; name: string }
  | { kind: "binary"; op: BinaryOp; left: ExprNode; right: ExprNode };

export type ParseExprResult = { ok: true; node: ExprNode } | { ok: false; error: string };

const COMPARISON_OPS = new Set<BinaryOp>([">", ">=", "<", "<=", "==", "!="]);
const ARITH_OPS = new Set<BinaryOp>(["+", "-", "*", "/"]);

/** select 的谓词必须是顶层比较（结果是布尔）。 */
export function isComparisonExpr(node: ExprNode): boolean {
  return node.kind === "binary" && COMPARISON_OPS.has(node.op);
}

// ---------------------------------------------------------------------------
// 解析（递归下降，白名单）
// ---------------------------------------------------------------------------

class ExprParser {
  private pos = 0;
  constructor(private readonly src: string) {}

  private skipSpace(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos] ?? "")) this.pos += 1;
  }

  private peek(): string | undefined {
    this.skipSpace();
    return this.src[this.pos];
  }

  private consume(expect: string): boolean {
    this.skipSpace();
    if (this.src[this.pos] === expect) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private parse(): ParseExprResult {
    const node = this.parseComparison();
    if (!node) return { ok: false, error: "表达式为空或语法错误" };
    this.skipSpace();
    if (this.pos < this.src.length) return { ok: false, error: `表达式结尾有多余内容："${this.src.slice(this.pos)}"` };
    return { ok: true, node };
  }

  private parseComparison(): ExprNode | undefined {
    const left = this.parseAdditive();
    if (!left) return undefined;
    this.skipSpace();
    const op = (this.src[this.pos] ?? "") + (this.src[this.pos + 1] ?? "");
    const twoChar = [">=", "<=", "==", "!="];
    if (twoChar.includes(op)) {
      this.pos += 2;
      const right = this.parseAdditive();
      if (!right) return undefined;
      return { kind: "binary", op: op as BinaryOp, left, right };
    }
    if (this.src[this.pos] === ">" || this.src[this.pos] === "<") {
      const op = this.src[this.pos] as BinaryOp;
      this.pos += 1;
      const right = this.parseAdditive();
      if (!right) return undefined;
      return { kind: "binary", op, left, right };
    }
    return left;
  }

  private parseAdditive(): ExprNode | undefined {
    let node = this.parseMultiplicative();
    if (!node) return undefined;
    for (;;) {
      this.skipSpace();
      const op = this.src[this.pos];
      if (op !== "+" && op !== "-") return node;
      this.pos += 1;
      const right = this.parseMultiplicative();
      if (!right) return undefined;
      node = { kind: "binary", op, left: node, right };
    }
  }

  private parseMultiplicative(): ExprNode | undefined {
    let node = this.parseUnary();
    if (!node) return undefined;
    for (;;) {
      this.skipSpace();
      const op = this.src[this.pos];
      if (op !== "*" && op !== "/") return node;
      this.pos += 1;
      const right = this.parseUnary();
      if (!right) return undefined;
      node = { kind: "binary", op, left: node, right };
    }
  }

  private parseUnary(): ExprNode | undefined {
    this.skipSpace();
    if (this.src[this.pos] === "-") {
      this.pos += 1;
      const operand = this.parseUnary();
      if (!operand) return undefined;
      return { kind: "binary", op: "-", left: { kind: "number", value: 0 }, right: operand };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ExprNode | undefined {
    this.skipSpace();
    if (this.pos >= this.src.length) return undefined;
    const char = this.src[this.pos];

    if (char === "(") {
      this.pos += 1;
      const node = this.parseComparison();
      if (!node || !this.consume(")")) return undefined;
      return node;
    }

    if (char === '"' || char === "'") {
      const quote = char;
      this.pos += 1;
      let value = "";
      while (this.pos < this.src.length && this.src[this.pos] !== quote) {
        value += this.src[this.pos];
        this.pos += 1;
      }
      if (this.pos >= this.src.length) return undefined;
      this.pos += 1;
      return { kind: "string", value };
    }

    // 数字
    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(this.src[this.pos + 1] ?? ""))) {
      let raw = "";
      while (this.pos < this.src.length && /[0-9.]/.test(this.src[this.pos] ?? "")) {
        raw += this.src[this.pos];
        this.pos += 1;
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) return undefined;
      return { kind: "number", value };
    }

    // 标识符（字段引用 / true/false/null）
    if (/[A-Za-z_]/.test(char)) {
      let raw = "";
      while (this.pos < this.src.length && /[A-Za-z0-9_.]/.test(this.src[this.pos] ?? "")) {
        raw += this.src[this.pos];
        this.pos += 1;
      }
      if (raw === "true") return { kind: "bool", value: true };
      if (raw === "false") return { kind: "bool", value: false };
      if (raw === "null") return { kind: "null" };
      // 字段名允许点号路径（如 detail.full_name）？R4e 元素是扁平对象，禁止点号避免歧义
      if (raw.includes(".")) return undefined;
      return { kind: "field", name: raw };
    }

    return undefined;
  }
}

export function parseExpr(src: string): ParseExprResult {
  if (typeof src !== "string" || src.trim() === "") return { ok: false, error: "表达式为空" };
  return new ExprParser(src).parse();
}

// ---------------------------------------------------------------------------
// 求值（元素级纯函数；undefined 字段参与比较时视为最小）
// ---------------------------------------------------------------------------

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : 1;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  const aNum = typeof a === "number" ? a : Number(a);
  const bNum = typeof b === "number" ? b : Number(b);
  if (Number.isNaN(aNum)) return -1;
  if (Number.isNaN(bNum)) return 1;
  return aNum - bNum;
}

function equals(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a === "string" && typeof b === "string") return a === b;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b;
  return String(a) === String(b);
}

export function evalExpr(node: ExprNode, record: Readonly<Record<string, unknown>>): unknown {
  switch (node.kind) {
    case "number":
    case "string":
    case "bool":
      return node.value;
    case "null":
      return null;
    case "field":
      return record[node.name];
    case "binary": {
      if (ARITH_OPS.has(node.op)) {
        const a = Number(evalExpr(node.left, record));
        const b = Number(evalExpr(node.right, record));
        if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
        switch (node.op) {
          case "+":
            return a + b;
          case "-":
            return a - b;
          case "*":
            return a * b;
          case "/":
            return b === 0 ? Number.NaN : a / b;
        }
      }
      const left = evalExpr(node.left, record);
      const right = evalExpr(node.right, record);
      switch (node.op) {
        case "==":
          return equals(left, right);
        case "!=":
          return !equals(left, right);
        case ">":
          return compare(left, right) > 0;
        case ">=":
          return compare(left, right) >= 0;
        case "<":
          return compare(left, right) < 0;
        case "<=":
          return compare(left, right) <= 0;
      }
      return false;
    }
  }
}
