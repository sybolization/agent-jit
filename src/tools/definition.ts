import type { TSchema } from "typebox";

/**
 * 工具唯一事实源：契约（id/label/description/schema）+ 执行体。
 * 静态契约（如 githubTools）可省略 execute；provider（real/mock/adversarial）
 * 在注册为 RuntimeTool 时补上 execute。
 */
export interface ToolDefinition {
  id: string;
  label: string;
  description?: string;
  inputSchema: TSchema;
  outputSchema: TSchema;
  execute?(input: unknown): Promise<unknown>;
}

export function defineTool(definition: ToolDefinition): ToolDefinition {
  return definition;
}
