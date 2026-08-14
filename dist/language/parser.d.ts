import type { ParseResult, Token } from "./ast.js";
/**
 * DSL 递归下降 parser：把 token 流解析为语句列表。
 *
 * 错误恢复策略：单条语句失败时跳到行尾继续，从而一次返回批量诊断
 * （agent 可以一次修完所有错误，而不是逐轮往返）。产出是中性 AST
 * （`ParsedStatement`），语义校验交给编译后端。
 */
export declare class Parser {
    private pos;
    private readonly tokens;
    private readonly definedNodes;
    constructor(tokens: Token[]);
    parse(): ParseResult;
    private peek;
    private peekNext;
    private next;
    private skipToNewline;
    private parseStatement;
    private parseArgsAndEnd;
    /** 解析 `<args> ")"`；不检查行尾（表达式级 call 复用，后面可能跟外层 `)` 或 `,`）。 */
    private parseArgsToClose;
    private parseArg;
    private parseValue;
}
