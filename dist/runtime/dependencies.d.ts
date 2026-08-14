import type { ExecutionNode } from "../compiler/ir.js";
/**
 * 依赖解析：从 IR 节点提取"数据流依赖"（被引用的变量名）。
 *
 * 变量引用即边——`args` 中的 `{ kind: "ref" }`、`map/compute` 的
 * `source`、`return` 的 `value` 都是上游依赖。runtime 据此建立
 * 依赖计数与就绪队列，**绝不依赖 nodes 数组顺序**。
 */
export declare function nodeDependencies(node: ExecutionNode): readonly string[];
