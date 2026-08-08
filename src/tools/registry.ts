import type { ToolDefinition } from "./definition.js";

/** 工具注册表：register / get / has / all / ids。Compiler、catalog、Runtime 共同消费。 */
export class ToolRegistry {
  private readonly byId = new Map<string, ToolDefinition>();
  constructor(definitions: readonly ToolDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }
  register(definition: ToolDefinition): void {
    this.byId.set(definition.id, definition);
  }
  get(id: string): ToolDefinition | undefined {
    return this.byId.get(id);
  }
  has(id: string): boolean {
    return this.byId.has(id);
  }
  all(): readonly ToolDefinition[] {
    return [...this.byId.values()];
  }
  ids(): readonly string[] {
    return [...this.byId.keys()];
  }
}
