/**
 * 值存储：变量名 → 执行结果。节点执行完成后写入，依赖它的节点从中解析引用。
 */
export class ValueStore {
  private readonly values = new Map<string, unknown>();

  set(name: string, value: unknown): void {
    this.values.set(name, value);
  }

  get(name: string): unknown {
    if (!this.values.has(name)) {
      throw new Error(`ValueStore: 变量“${name}”尚不可用（依赖未执行或不存在）`);
    }
    return this.values.get(name);
  }
}
