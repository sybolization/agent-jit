import { editDistance } from "../../tools/registry.js";
import { dshToolAsRegisteredTool } from "./toolAdapter.js";
/** 元工具缺省排除名单：DSL 程序不能编排 JIT 自身（否则无限递归）。 */
const DEFAULT_META_NAMES = ["jit_describe_tools", "jit_execute_program"];
/** describe 场景的 unreachable caller：契约渲染不执行任何宿主工具。 */
export function unreachableHostCaller() {
    return async () => {
        throw new Error("jit_describe_tools 只渲染契约，不执行宿主工具");
    };
}
/** 近似匹配阈值（与 registry.ts 的 withinThreshold 同规则）。 */
function withinThreshold(name, candidate, distance) {
    const maxLen = Math.max(name.length, candidate.length);
    return distance <= 2 && distance <= Math.max(1, Math.floor(maxLen / 3));
}
/** 判断 tools 是否具有 ToolRuntime 形状（测试 stub 缺 get/schemas 时视为无宿主）。 */
function isToolRuntime(tools) {
    return (typeof tools.get === "function" &&
        typeof tools.schemas === "function");
}
/** 宿主工具活视图：实时查 ctx.tools，实现 ToolCatalog（compiler / describe / runtime 共用）。 */
export class HostToolView {
    tools;
    scope;
    caller;
    base;
    allow;
    exclude;
    meta;
    constructor(options) {
        this.tools = options.tools;
        this.scope = options.scope;
        this.caller = options.caller;
        this.base = options.base;
        this.allow = options.allow === undefined ? undefined : new Set(options.allow);
        this.exclude = new Set(options.exclude ?? []);
        this.meta = new Set([...DEFAULT_META_NAMES, ...(options.metaNames ?? [])]);
    }
    /** 该名字是否被允许暴露（白名单未配置 = 全部；黑名单 / 元工具 / base 已覆盖 → 排除）。 */
    admits(name) {
        if (this.exclude.has(name) || this.meta.has(name))
            return false;
        if (this.base !== undefined && this.base.resolveId(name) !== undefined)
            return false;
        if (this.allow !== undefined && !this.allow.has(name))
            return false;
        return true;
    }
    /** 实时解析单个宿主工具（未注册 / 被排除 / tools 无 get 能力 → undefined）。 */
    get(name) {
        if (!this.admits(name) || !isToolRuntime(this.tools))
            return undefined;
        const definition = this.tools.get(name, this.scope);
        if (definition === undefined)
            return undefined;
        return dshToolAsRegisteredTool(definition, this.caller);
    }
    /** 枚举全部可见宿主工具（ctx.tools.schemas 投影名字 → 逐个实时解析）。 */
    all() {
        if (!isToolRuntime(this.tools))
            return [];
        const names = this.tools.schemas(this.scope).map((schema) => schema.name);
        const result = [];
        for (const name of names) {
            if (!this.admits(name))
                continue;
            const tool = this.get(name);
            if (tool !== undefined)
                result.push(tool);
        }
        return result;
    }
    /**
     * 名字解析：宿主工具原名优先；再试"点号 → 下划线"别名（与 DSL 的
     * `service.func` / `service_func` 两种写法等价规则一致）。
     */
    resolveId(name) {
        if (this.get(name) !== undefined)
            return name;
        const alias = name.replace(/\./g, "_");
        if (alias !== name && this.get(alias) !== undefined)
            return alias;
        return undefined;
    }
    /** 确定性近似建议：对可见宿主工具名做编辑距离匹配（与 base 同阈值）。 */
    suggestIds(name, max = 2) {
        const matches = [];
        for (const tool of this.all()) {
            const distance = editDistance(name, tool.id);
            if (!withinThreshold(name, tool.id, distance))
                continue;
            matches.push({ id: tool.id, distance });
        }
        matches.sort((left, right) => left.distance - right.distance || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
        return matches.slice(0, max).map(({ id }) => ({ alias: id, canonical: id }));
    }
}
