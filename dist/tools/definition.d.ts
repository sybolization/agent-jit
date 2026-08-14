import type { TSchema } from "typebox";
/**
 * 静态工具契约：id / label / description / inputSchema / outputSchema。
 * 不携带 execute——"静态契约"与"可运行工具"在类型层分离：
 * provider（real / mock）绑定 execute 后即为 RegisteredTool。
 */
export interface ToolContract {
    id: string;
    label: string;
    description?: string;
    inputSchema: TSchema;
    outputSchema: TSchema;
}
/** 已绑定实现的可运行工具：在 ToolContract 之上要求 execute 必填。 */
export interface RegisteredTool extends ToolContract {
    execute(input: unknown): Promise<unknown>;
}
/** 声明工具契约（泛型保留具体类型：传入含 execute 的对象时返回 RegisteredTool）。 */
export declare function defineTool<T extends ToolContract>(definition: T): T;
