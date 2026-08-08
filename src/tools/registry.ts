import type { ToolContract } from "./definition.js";

/** 三方共享的薄接口：compiler / catalog renderer / runtime 只依赖 get / all。 */
export interface ToolCatalog {
  get(id: string): ToolContract | undefined;
  all(): readonly ToolContract[];
}

/** 工具注册表：register / get / has / all / ids。泛型 T 保留具体契约类型（如 RegisteredTool）。 */
export class ToolRegistry<T extends ToolContract = ToolContract> implements ToolCatalog {
  private readonly byId = new Map<string, T>();
  constructor(definitions: readonly T[] = []) {
    for (const definition of definitions) this.register(definition);
  }
  register(definition: T): void {
    this.byId.set(definition.id, definition);
  }
  get(id: string): T | undefined {
    return this.byId.get(id);
  }
  has(id: string): boolean {
    return this.byId.has(id);
  }
  all(): readonly T[] {
    return [...this.byId.values()];
  }
  ids(): readonly string[] {
    return [...this.byId.keys()];
  }
}
