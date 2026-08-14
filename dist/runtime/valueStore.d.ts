/**
 * 值存储：变量名 → 执行结果。节点执行完成后写入，依赖它的节点从中解析引用。
 */
export declare class ValueStore {
    private readonly values;
    set(name: string, value: unknown): void;
    get(name: string): unknown;
}
