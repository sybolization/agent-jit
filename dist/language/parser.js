/**
 * DSL 递归下降 parser：把 token 流解析为语句列表。
 *
 * 错误恢复策略：单条语句失败时跳到行尾继续，从而一次返回批量诊断
 * （agent 可以一次修完所有错误，而不是逐轮往返）。产出是中性 AST
 * （`ParsedStatement`），语义校验交给编译后端。
 */
export class Parser {
    pos = 0;
    tokens;
    definedNodes = new Set();
    constructor(tokens) {
        this.tokens = tokens;
    }
    parse() {
        const statements = [];
        const diagnostics = [];
        while (this.peek()?.type !== "eof") {
            if (this.peek()?.type === "newline") {
                this.pos += 1;
                continue;
            }
            const before = this.pos;
            const statement = this.parseStatement(diagnostics);
            if (statement) {
                statements.push(statement);
                this.definedNodes.add(statement.name);
            }
            // 防御：任何解析路径都必须推进；否则强制跳过，避免死循环
            if (this.pos === before)
                this.pos += 1;
        }
        return { statements, diagnostics };
    }
    peek() {
        return this.tokens[this.pos];
    }
    peekNext() {
        return this.tokens[this.pos + 1];
    }
    next() {
        const token = this.tokens[this.pos];
        if (token?.type !== "eof")
            this.pos += 1;
        return token;
    }
    skipToNewline() {
        while (this.peek()?.type !== "newline" && this.peek()?.type !== "eof")
            this.pos += 1;
    }
    parseStatement(diagnostics) {
        const startLine = this.peek()?.line ?? 0;
        const nameToken = this.next();
        if (nameToken?.type !== "ident") {
            diagnostics.push({
                line: nameToken?.line ?? startLine,
                code: "syntax",
                message: "语句必须以节点名称开头",
                suggestion: "格式：<名称> = <工作流或内置节点>(<参数>=<值>)",
            });
            this.skipToNewline();
            return undefined;
        }
        // `return(...)` / `return <value>` 无赋值形态：return 是语言关键字，无变量名，name 占位为 "return"。
        // 必须先于 `this.next()` 消费下一个 token（否则会吃掉 return 后面的值）。
        if (nameToken.value === "return") {
            const after = this.peek();
            if (after?.type === "symbol" && after.value === "(") {
                this.pos += 1;
                const args = this.parseArgsAndEnd(diagnostics, startLine);
                if (!args)
                    return undefined;
                return { line: startLine, name: "return", callee: "return", args };
            }
            // 无括号形态：return <value>（值位置即 position 0，语义映射交给编译后端）
            const value = this.parseValue(diagnostics);
            if (!value)
                return undefined;
            const ending = this.peek();
            if (ending?.type === "newline" || ending?.type === "eof") {
                if (ending.type === "newline")
                    this.pos += 1;
            }
            else {
                diagnostics.push({
                    line: ending?.line ?? startLine,
                    code: "syntax",
                    message: "一条语句必须独占一行",
                    suggestion: "每条 <名称> = <工作流>(...) 或 return <值> 单独成行",
                });
                this.skipToNewline();
                return undefined;
            }
            return { line: startLine, name: "return", callee: "return", args: [{ line: startLine, value }] };
        }
        const equals = this.next();
        if (equals?.type !== "symbol" || equals.value !== "=") {
            diagnostics.push({
                line: equals?.line ?? startLine,
                code: "syntax",
                message: `“${nameToken.value}”后缺少等号`,
                suggestion: "格式：<名称> = <工作流>(<参数>=<值>)",
            });
            this.skipToNewline();
            return undefined;
        }
        const calleeToken = this.next();
        if (calleeToken?.type !== "ident") {
            diagnostics.push({
                line: calleeToken?.line ?? startLine,
                code: "syntax",
                message: `“${nameToken.value} =”后缺少工作流或节点类型`,
                suggestion: calleeToken?.type === "string"
                    ? "赋值右边必须是工作流 id 或内置节点（text、asset）。若该行是某工作流的参数，说明你用了逐行写参数的方式；DSL 要求单行：名称 = 工作流(参数=值, …)"
                    : "使用已注册工作流 id 或内置节点（text、asset）",
            });
            this.skipToNewline();
            return undefined;
        }
        const open = this.next();
        if (open?.type !== "symbol" || open.value !== "(") {
            diagnostics.push({
                line: open?.line ?? startLine,
                code: "syntax",
                message: `“${calleeToken.value}”后缺少左括号`,
                suggestion: this.definedNodes.has(calleeToken.value)
                    ? `“${calleeToken.value}”是先前定义的节点，不能作为工作流调用；引用它的输出请写成：名称 = 工作流(输入名 = ${calleeToken.value})`
                    : "DSL 要求单行调用：名称 = 工作流(参数=值, …)，参数不要换行缩进",
            });
            this.skipToNewline();
            return undefined;
        }
        const args = this.parseArgsAndEnd(diagnostics, startLine);
        if (!args)
            return undefined;
        return { line: startLine, name: nameToken.value, callee: calleeToken.value, args };
    }
    parseArgsAndEnd(diagnostics, startLine) {
        const args = this.parseArgsToClose(diagnostics, startLine);
        if (!args)
            return undefined;
        const ending = this.peek();
        if (ending?.type === "newline" || ending?.type === "eof") {
            if (ending.type === "newline")
                this.pos += 1;
        }
        else {
            diagnostics.push({
                line: ending?.line ?? startLine,
                code: "syntax",
                message: "一条语句必须独占一行",
                suggestion: "每条 <名称> = <工作流>(...) 单独成行",
            });
            this.skipToNewline();
            return undefined;
        }
        return args;
    }
    /** 解析 `<args> ")"`；不检查行尾（表达式级 call 复用，后面可能跟外层 `)` 或 `,`）。 */
    parseArgsToClose(diagnostics, startLine) {
        const args = [];
        if (this.peek()?.type === "symbol" && this.peek()?.value === ")") {
            this.pos += 1;
            return args;
        }
        for (;;) {
            const arg = this.parseArg(diagnostics);
            if (!arg)
                return undefined;
            args.push(arg);
            const separator = this.next();
            if (separator?.type === "symbol" && separator.value === ")")
                break;
            if (separator?.type === "symbol" && separator.value === ",")
                continue;
            diagnostics.push({
                line: separator?.line ?? startLine,
                code: "syntax",
                message: "参数列表缺少逗号或右括号",
                suggestion: "格式：<key>=<value>，参数之间用逗号分隔",
            });
            this.skipToNewline();
            return undefined;
        }
        return args;
    }
    parseArg(diagnostics) {
        const startLine = this.peek()?.line ?? 0;
        // keyword 形态：<ident>=<value>
        if (this.peek()?.type === "ident" && this.peekNext()?.type === "symbol" && this.peekNext()?.value === "=") {
            const keyToken = this.next();
            this.next(); // 吃掉 =
            const value = this.parseValue(diagnostics);
            if (!value)
                return undefined;
            return { line: startLine, key: keyToken.value, value };
        }
        // positional 形态：<value>（key 为 undefined，语义映射交给编译后端）
        const value = this.parseValue(diagnostics);
        if (!value)
            return undefined;
        return { line: startLine, value };
    }
    parseValue(diagnostics) {
        const token = this.peek();
        if (!token)
            return undefined;
        if (token.type === "string") {
            this.pos += 1;
            return { line: token.line, kind: "literal", literal: token.value };
        }
        if (token.type === "number") {
            this.pos += 1;
            return { line: token.line, kind: "literal", literal: Number(token.value) };
        }
        if (token.type === "ident") {
            const startLine = token.line;
            this.pos += 1;
            if (token.value === "true")
                return { line: startLine, kind: "literal", literal: true };
            if (token.value === "false")
                return { line: startLine, kind: "literal", literal: false };
            if (token.value === "null")
                return { line: startLine, kind: "literal", literal: null };
            // lambda 表达式（受限）：lambda <param>: <call>
            if (token.value === "lambda") {
                const paramToken = this.peek();
                if (paramToken?.type !== "ident") {
                    diagnostics.push({
                        line: paramToken?.line ?? startLine,
                        code: "syntax",
                        message: "lambda 后缺少参数名",
                        suggestion: "格式：lambda <参数名>: <调用>(<参数>=<值>)",
                    });
                    this.skipToNewline();
                    return undefined;
                }
                this.pos += 1;
                const colon = this.peek();
                if (colon?.type !== "symbol" || colon.value !== ":") {
                    diagnostics.push({
                        line: colon?.line ?? startLine,
                        code: "syntax",
                        message: "lambda 参数后缺少冒号",
                        suggestion: "格式：lambda <参数名>: <调用>(<参数>=<值>)",
                    });
                    this.skipToNewline();
                    return undefined;
                }
                this.pos += 1;
                const body = this.parseValue(diagnostics);
                if (!body)
                    return undefined;
                return { line: startLine, kind: "lambda", param: paramToken.value, body };
            }
            // 嵌套调用表达式（表达式级 call，不检查行尾）：<ident>(<参数>...)
            const next = this.peek();
            if (next?.type === "symbol" && next.value === "(") {
                this.pos += 1;
                const args = this.parseArgsToClose(diagnostics, startLine);
                if (!args)
                    return undefined;
                return { line: startLine, kind: "call", callee: token.value, args };
            }
            return { line: startLine, kind: "ref", name: token.value };
        }
        if (token.type === "symbol" && token.value === "[") {
            this.pos += 1;
            const items = [];
            for (;;) {
                const itemToken = this.peek();
                if (!itemToken)
                    break;
                if (itemToken.type === "symbol" && itemToken.value === "]") {
                    this.pos += 1;
                    break;
                }
                const item = this.parseValue(diagnostics);
                if (!item)
                    break;
                if (item.kind === "ref") {
                    diagnostics.push({
                        line: item.line,
                        code: "syntax",
                        message: "数组内不能引用节点",
                        suggestion: '数组只接受字面量：["a", "b"]',
                    });
                }
                else {
                    items.push(item.literal ?? null);
                }
                const separator = this.next();
                if (separator?.type === "symbol" && separator.value === "]")
                    break;
                if (separator?.type === "symbol" && separator.value === ",")
                    continue;
                diagnostics.push({
                    line: separator?.line ?? token.line,
                    code: "syntax",
                    message: "数组缺少逗号或右括号",
                    suggestion: '格式：["a", "b"]',
                });
                this.skipToNewline();
                return undefined;
            }
            return { line: token.line, kind: "literal", literal: items };
        }
        if (token.type === "eof") {
            // 不推进 pos：eof 之后的 pos 越界会让 peek() 返回 undefined，触发主循环死循环
            diagnostics.push({
                line: token.line,
                code: "syntax",
                message: "语句意外结束（缺少参数值或右括号）",
                suggestion: '引用节点：reference_image=img；字面量：prompt="一只猫"；或补上 ")"',
            });
            return undefined;
        }
        diagnostics.push({
            line: token.line,
            code: "syntax",
            message: "参数值必须是字符串、数字、布尔、null、数组或前面已定义节点的名称",
            suggestion: '引用节点：reference_image=img；字面量：prompt="一只猫"',
        });
        this.pos += 1;
        return undefined;
    }
}
