import type { ToolRuntime } from "@deepseek-ai/dsh-tools";
import type { RegisteredTool } from "../../tools/definition.js";
import { editDistance, type ToolCatalog, type ToolIdSuggestion } from "../../tools/registry.js";
import { dshToolAsRegisteredTool, type DslToolCaller } from "./toolAdapter.js";

/**
 * DSH 宿主工具"活视图"目录（hostDiscovery）。
 *
 * 取代旧的"apply 时快照"（plugin.ts 在插件加载那一刻把 config.hostTools 里的
 * 名字解析成 ToolDefinition 列表，之后新增/动态注册的工具永远进不来）：
 * 本目录**不持有工具定义**，每次 get / all 实时查 ctx.tools（ToolRuntime）——
 *
 * - get(name)：ctx.tools.get(name, scope) 实时解析 → dshToolAsRegisteredTool 适配；
 * - all()：ctx.tools.schemas(scope) 枚举全部可见工具 → 逐个适配；
 * - scope 感知：describe / execute 时把调用方的 exec.agent 透传给 ctx.tools，
 *   与模型可见面一致（per-agent restrict / scoped 注册自然生效）；
 * - 自动排除：jit_* 元工具自身（防递归）、base（插件自有工具）已覆盖的名字、
 *   用户黑名单；白名单未配置时 = 全部自动发现——**零配置、零代码修改**，
 *   任何注册进 DSH 的工具（其他插件 / 动态注册 / 后加载）describe 即用、
 *   DSL 直接可编排。
 *
 * 执行语义不变：宿主工具经 DslToolCaller 闭包 → ctx.tools.execute 嵌套分发，
 * 走完整策略管线（guard / pre-execute / post-execute / 超时 / 沙箱）。
 */

/** 宿主工具目录的 scope 类型：与 ToolRuntime.get / schemas 的 ScopeKey 一致。 */
type ScopeKey = Parameters<ToolRuntime["get"]>[1];

export interface HostToolViewOptions {
  /** DSH 工具注册表（ctx.tools）。非 ToolRuntime 形状（测试 stub）时目录为空。 */
  tools: ToolRuntime;
  /** 当前 agent scope（exec.agent）；undefined = 全局视图。 */
  scope?: ScopeKey;
  /** 宿主工具执行分发闭包（describe 场景传 unreachable caller，不执行）。 */
  caller: DslToolCaller;
  /** base 目录（插件自有工具）：这些名字宿主侧不再暴露（base 优先）。 */
  base?: ToolCatalog;
  /** 白名单：undefined = 自动发现全部；[] = 关闭；非空 = 只允许这些名字。 */
  allow?: readonly string[];
  /** 黑名单：始终排除（白名单之外的第二道闸）。 */
  exclude?: readonly string[];
  /** 始终排除的元工具名（缺省 jit_*，防递归）。 */
  metaNames?: readonly string[];
}

/** 元工具缺省排除名单：DSL 程序不能编排 JIT 自身（否则无限递归）。 */
const DEFAULT_META_NAMES = ["jit_describe_tools", "jit_execute_program"] as const;

/** describe 场景的 unreachable caller：契约渲染不执行任何宿主工具。 */
export function unreachableHostCaller(): DslToolCaller {
  return async () => {
    throw new Error("jit_describe_tools 只渲染契约，不执行宿主工具");
  };
}

/** 近似匹配阈值（与 registry.ts 的 withinThreshold 同规则）。 */
function withinThreshold(name: string, candidate: string, distance: number): boolean {
  const maxLen = Math.max(name.length, candidate.length);
  return distance <= 2 && distance <= Math.max(1, Math.floor(maxLen / 3));
}

/** 判断 tools 是否具有 ToolRuntime 形状（测试 stub 缺 get/schemas 时视为无宿主）。 */
function isToolRuntime(tools: ToolRuntime): tools is ToolRuntime {
  return (
    typeof (tools as Partial<ToolRuntime>).get === "function" &&
    typeof (tools as Partial<ToolRuntime>).schemas === "function"
  );
}

/** 宿主工具活视图：实时查 ctx.tools，实现 ToolCatalog（compiler / describe / runtime 共用）。 */
export class HostToolView implements ToolCatalog {
  private readonly tools: ToolRuntime;
  private readonly scope: ScopeKey | undefined;
  private readonly caller: DslToolCaller;
  private readonly base: ToolCatalog | undefined;
  private readonly allow: ReadonlySet<string> | undefined;
  private readonly exclude: ReadonlySet<string>;
  private readonly meta: ReadonlySet<string>;

  constructor(options: HostToolViewOptions) {
    this.tools = options.tools;
    this.scope = options.scope;
    this.caller = options.caller;
    this.base = options.base;
    this.allow = options.allow === undefined ? undefined : new Set(options.allow);
    this.exclude = new Set(options.exclude ?? []);
    this.meta = new Set([...DEFAULT_META_NAMES, ...(options.metaNames ?? [])]);
  }

  /** 该名字是否被允许暴露（白名单未配置 = 全部；黑名单 / 元工具 / base 已覆盖 → 排除）。 */
  private admits(name: string): boolean {
    if (this.exclude.has(name) || this.meta.has(name)) return false;
    if (this.base !== undefined && this.base.resolveId(name) !== undefined) return false;
    if (this.allow !== undefined && !this.allow.has(name)) return false;
    return true;
  }

  /** 实时解析单个宿主工具（未注册 / 被排除 / tools 无 get 能力 → undefined）。 */
  get(name: string): RegisteredTool | undefined {
    if (!this.admits(name) || !isToolRuntime(this.tools)) return undefined;
    const definition = this.tools.get(name, this.scope);
    if (definition === undefined) return undefined;
    return dshToolAsRegisteredTool(definition, this.caller);
  }

  /** 枚举全部可见宿主工具（ctx.tools.schemas 投影名字 → 逐个实时解析）。 */
  all(): readonly RegisteredTool[] {
    if (!isToolRuntime(this.tools)) return [];
    const names = this.tools.schemas(this.scope).map((schema) => schema.name);
    const result: RegisteredTool[] = [];
    for (const name of names) {
      if (!this.admits(name)) continue;
      const tool = this.get(name);
      if (tool !== undefined) result.push(tool);
    }
    return result;
  }

  /**
   * 名字解析：宿主工具原名优先；再试"点号 → 下划线"别名（与 DSL 的
   * `service.func` / `service_func` 两种写法等价规则一致）。
   */
  resolveId(name: string): string | undefined {
    if (this.get(name) !== undefined) return name;
    const alias = name.replace(/\./g, "_");
    if (alias !== name && this.get(alias) !== undefined) return alias;
    return undefined;
  }

  /** 确定性近似建议：对可见宿主工具名做编辑距离匹配（与 base 同阈值）。 */
  suggestIds(name: string, max = 2): readonly ToolIdSuggestion[] {
    const matches: { id: string; distance: number }[] = [];
    for (const tool of this.all()) {
      const distance = editDistance(name, tool.id);
      if (!withinThreshold(name, tool.id, distance)) continue;
      matches.push({ id: tool.id, distance });
    }
    matches.sort(
      (left, right) => left.distance - right.distance || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
    return matches.slice(0, max).map(({ id }) => ({ alias: id, canonical: id }));
  }
}
