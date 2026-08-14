/**
 * 值存储：变量名 → 执行结果。节点执行完成后写入，依赖它的节点从中解析引用。
 */
export class ValueStore {
    values = new Map();
    set(name, value) {
        this.values.set(name, value);
    }
    get(name) {
        if (!this.values.has(name)) {
            throw new Error(`ValueStore: 变量“${name}”尚不可用（依赖未执行或不存在）`);
        }
        return this.values.get(name);
    }
}
