import { nodeDependencies } from "./dependencies.js";
import { executeNode } from "./executor.js";
import { ValueStore } from "./valueStore.js";
export async function execute(graph, registry) {
    const started = performance.now();
    const store = new ValueStore();
    const trace = [];
    const ctx = { registry, store, trace };
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    // 1. 依赖扫描 + 计数 + 依赖者索引。
    //    结构错误（如"图中缺少依赖节点"）属于图不合法，仍在 try 之外抛出。
    const indegree = new Map();
    const dependents = new Map();
    for (const node of graph.nodes) {
        const deps = nodeDependencies(node);
        indegree.set(node.id, deps.length);
        for (const dep of deps) {
            if (!byId.has(dep)) {
                throw new Error(`图中缺少依赖节点“${dep}”（${node.id} 依赖它）`);
            }
            const list = dependents.get(dep) ?? [];
            list.push(node.id);
            dependents.set(dep, list);
        }
    }
    // 2. 就绪队列（无依赖者）。
    const ready = graph.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
    // 3. 循环执行：同一批就绪节点并发；完成后解锁依赖者。
    //    运行时错误（工具抛错 / schema 不匹配）统一捕获为 failed，不向上抛。
    //    REQ-4：同批用 Promise.allSettled——一个节点失败不取消同批已启动的兄弟节点，
    //    等本批全部 settle 后再决定是否继续调度后续批次。
    let completed = 0;
    let failed;
    try {
        while (ready.length > 0 && failed === undefined) {
            const batch = ready.splice(0);
            const results = await Promise.allSettled(batch.map(async (id) => {
                const node = byId.get(id);
                if (!node)
                    throw new Error(`未知节点：${id}`);
                const value = await executeNode(node, ctx);
                store.set(node.id, value);
                completed += 1;
                for (const dependent of dependents.get(id) ?? []) {
                    const remaining = (indegree.get(dependent) ?? 1) - 1;
                    indegree.set(dependent, remaining);
                    if (remaining === 0)
                        ready.push(dependent);
                }
            }));
            for (const result of results) {
                if (result.status === "rejected") {
                    // 首个失败即停止调度后续批次；本批其余节点已全部 settle（不取消）
                    failed = result.reason.message ?? String(result.reason);
                    break;
                }
            }
        }
        // 就绪队列耗尽但图未跑完 → 环或不可达依赖（如人工构造的 cycle）
        if (failed === undefined && completed !== graph.nodes.length) {
            failed = `GRAPH_CYCLE_OR_UNRESOLVED_DEPENDENCY: 已完成 ${completed}/${graph.nodes.length} 个节点`;
        }
    }
    catch (error) {
        // 调度器自身的意外错误（节点级错误已由 allSettled 收集，不会走到这里）
        failed = error.message ?? String(error);
    }
    if (failed !== undefined) {
        return {
            status: "failed",
            error: failed,
            trace,
            totalDurationMs: Math.round(performance.now() - started),
        };
    }
    const returnNode = graph.nodes.find((node) => node.kind === "return");
    const result = returnNode ? store.get(returnNode.id) : undefined;
    const totalDurationMs = Math.round(performance.now() - started);
    return { status: "success", result, trace, totalDurationMs };
}
