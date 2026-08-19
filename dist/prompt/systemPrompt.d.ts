/**
 * Agent JIT 的统一 DSL 系统提示词构造（DSL 臂）。
 *
 * 常驻 context 只需要：DSL 语法/原则 + 两个元工具（jit_describe_tools / jit_execute_program）。
 * 具体业务工具的 DSL 契约**不内嵌**在提示词里——模型天然知道有哪些业务工具、单次如何调用
 * （Pi 的 Tool Calling 通道以 JSON schema 注册）；当它决定把若干工具编排成程序时，按需调用
 * jit_describe_tools 获取这些工具的输入 + 输出契约，再写程序、调用 jit_execute_program 提交。
 *
 * 两通道：
 * - iterative 臂：模型直接调用业务工具 → `gateway.complete(..., { tools })` 注册；
 * - DSL 臂：模型只调两个 jit_* 元工具（见 src/tools/jitTools.ts），把业务工具当作
 *   DSL callee 写进程序 → 元工具目录经 gateway `tools` 参数动态注册。
 */
/** 语言构造条目注册表（单一事实源；各实验按需启用子集，语法说明不再各写一份）。 */
export declare const DSL_CONSTRUCTS: Record<string, readonly string[]>;
/** 语言关键字（出现在 <callee> 说明中；顺序即展示顺序）。join 是 merge_by_key 的遗留别名，不再向模型公开。 */
export declare const LANGUAGE_KEYWORDS: string[];
export interface DslSystemPromptOptions {
    /** 启用的语言构造（DSL_CONSTRUCTS 的键）；关键字列表由其与 LANGUAGE_KEYWORDS 求交得出 */
    constructs: readonly string[];
    /** 追加的硬约束（自动编号，追加在默认约束之后） */
    constraints?: readonly string[];
}
export declare function buildDslSystemPrompt(options: DslSystemPromptOptions): string;
