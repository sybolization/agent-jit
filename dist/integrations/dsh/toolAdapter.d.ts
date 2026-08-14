import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { RegisteredTool } from "../../tools/definition.js";
/**
 * DSH ToolDefinition ↔ agent-jit RegisteredTool 适配层。
 *
 * 方向 1（注册，plugin 自有工具）：RegisteredTool → DSH ToolDefinition。
 * - name 用 host alias（github.get_repository → github_get_repository）；
 * - description 注入实验验证的函数式 DSL 签名（r6 eager-signature 形态）：
 *
 *   ```text
 *   Fetch repository metadata.
 *   DSL: github.get_repository(full_name: str) -> {full_name: str, forks: int, stars: int}
 *   ```
 *
 *   普通调用时模型看 parameters；JIT 编程时模型看 DSL: 签名——两个接口来自
 *   同一个 ToolContract，签名与 jit_describe_tools 的契约渲染同源（dslSignature.ts）。
 * - execute 直接透传 RegisteredTool.execute（工具是插件自有的 provider，
 *   与 Pi 集成同一语义：普通工具只改名字与执行签名，行为零改动）。
 *
 * 方向 2（导入，DSH 宿主工具）：DSH ToolDefinition → RegisteredTool，
 * execute 通过调用方闭包走 ctx.tools.execute 嵌套分发（完整策略管线：
 * guard / pre-execute / post-execute / 超时），供 DSL 程序编排宿主工具。
 */
export interface DshToolAdapterOptions {
    /** 是否在 description 注入 DSL 函数式签名。缺省 "inline"（实验验证格式）。 */
    dslSignature?: "inline" | "none";
}
/** 单个 RegisteredTool → DSH ToolDefinition（注册用，name = host alias）。 */
export declare function adaptRegisteredTool(tool: RegisteredTool, options?: DshToolAdapterOptions): ToolDefinition;
/** 宿主工具调用闭包：按 name 分发一次嵌套工具调用（由 jit_execute_program 的执行期闭包提供）。 */
export type DslToolCaller = (name: string, args: unknown) => Promise<unknown>;
/**
 * DSH 宿主 ToolDefinition → agent-jit RegisteredTool（DSL 程序可编排宿主工具）。
 * id 用 DSH 原名（宿主工具无点号约定，不做 alias 转换）；输入输出 schema
 * 从 DSH JSON Schema 反向映射为 typebox（子集外结构回退 Type.Any，放行不误杀）。
 */
export declare function dshToolAsRegisteredTool(definition: ToolDefinition, caller: DslToolCaller): RegisteredTool;
