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
export type ExprNode = {
    kind: "number";
    value: number;
} | {
    kind: "string";
    value: string;
} | {
    kind: "bool";
    value: boolean;
} | {
    kind: "null";
} | {
    kind: "field";
    name: string;
} | {
    kind: "binary";
    op: BinaryOp;
    left: ExprNode;
    right: ExprNode;
};
export type ParseExprResult = {
    ok: true;
    node: ExprNode;
} | {
    ok: false;
    error: string;
};
/** select 的谓词必须是顶层比较（结果是布尔）。 */
export declare function isComparisonExpr(node: ExprNode): boolean;
export declare function parseExpr(src: string): ParseExprResult;
export declare function evalExpr(node: ExprNode, record: Readonly<Record<string, unknown>>): unknown;
