import type { ToolContract } from "./definition.js";

/**
 * ToolIdResolver：canonical id 与 host alias 的无感解析。
 *
 * 名字体系（. / _ 是宿主框架与 DSL 的表示差异，不应成为模型的认知负担）：
 * - canonical id：DSL / IR / 运行时唯一事实源（github.get_repository）；
 * - host alias：宿主框架（Pi）的工具名（github_get_repository），注册时自动生成。
 *   get / resolveId 两种形式等价解析；IR 永远只写 canonical id。
 *
 * 注册时构建"所有名字 → canonical id"索引；flatten collision
 * （foo.bar_baz 与 foo_bar.baz 都变成 foo_bar_baz）**fail fast 抛错**，
 * 不允许"最后注册的覆盖前一个"。
 */

/** canonical id → host alias：github.get_repository → github_get_repository（点号 → 下划线）。 */
export function toolIdAlias(id: string): string {
  return id.replace(/\./g, "_");
}

/** Levenshtein 编辑距离（未知工具名的确定性近似匹配用）。 */
export function editDistance(left: string, right: string): number {
  const m = left.length;
  const n = right.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

/** 未知名字的近似匹配建议（诊断 / describe 错误共用）。 */
export interface ToolIdSuggestion {
  /** host 写法（点号 → 下划线；无点号时等于 canonical） */
  alias: string;
  /** canonical id（IR / 诊断的事实源） */
  canonical: string;
}

/** 近似匹配阈值：编辑距离 ≤ 2 且 ≤ max(1, 最长名字 / 3)——相似度太低时不要硬推荐。 */
function withinThreshold(name: string, candidate: string, distance: number): boolean {
  const maxLen = Math.max(name.length, candidate.length);
  return distance <= 2 && distance <= Math.max(1, Math.floor(maxLen / 3));
}

/**
 * 三方共享的薄接口：compiler / catalog renderer / runtime 只依赖 get / all；
 * resolveId / suggestIds 是 ToolIdResolver 能力（canonical 与 host alias 无感解析）。
 */
export interface ToolCatalog {
  get(id: string): ToolContract | undefined;
  all(): readonly ToolContract[];
  /** 解析 canonical id 或 host alias → canonical id（未知返回 undefined）。 */
  resolveId(name: string): string | undefined;
  /** 未知名字的确定性近似建议（阈值内，最多 max 个；相似度太低不推荐）。 */
  suggestIds(name: string, max?: number): readonly ToolIdSuggestion[];
}

/** 工具注册表：register / get / has / all / ids。注册时构建 canonical + host alias 名索引。 */
export class ToolRegistry<T extends ToolContract = ToolContract> implements ToolCatalog {
  private readonly byId = new Map<string, T>();
  /** 所有可用名字（canonical id + host alias）→ canonical id。 */
  private readonly nameIndex = new Map<string, string>();

  constructor(definitions: readonly T[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: T): void {
    const id = definition.id;
    const alias = toolIdAlias(id);
    const names = alias === id ? [id] : [id, alias];
    for (const name of names) {
      const owner = this.nameIndex.get(name);
      if (owner !== undefined) {
        if (owner === id) throw new Error(`工具 id 重复注册：${id}`);
        throw new Error(
          `工具注册冲突：工具 “${id}” 的名字 “${name}” 与既有工具 “${owner}” flatten 后同名（host alias 无法唯一解析）`,
        );
      }
    }
    this.byId.set(id, definition);
    for (const name of names) this.nameIndex.set(name, id);
  }

  /** ToolIdResolver：canonical 或 host alias 无感解析 → canonical id（未知返回 undefined）。 */
  resolveId(name: string): string | undefined {
    return this.nameIndex.get(name);
  }

  get(name: string): T | undefined {
    const id = this.nameIndex.get(name);
    return id === undefined ? undefined : this.byId.get(id);
  }

  has(name: string): boolean {
    return this.nameIndex.has(name);
  }

  /** canonical id → host alias（Pi 工具注册 / 渲染提交名）。 */
  hostName(id: string): string {
    return toolIdAlias(id);
  }

  /** 确定性近似建议：距离升序 + canonical id 字典序稳定排序，最多 max 个。 */
  suggestIds(name: string, max = 2): readonly ToolIdSuggestion[] {
    const matches: { alias: string; canonical: string; distance: number }[] = [];
    for (const tool of this.byId.values()) {
      const alias = toolIdAlias(tool.id);
      const distance = Math.min(editDistance(name, tool.id), editDistance(name, alias));
      if (!withinThreshold(name, tool.id, distance)) continue;
      matches.push({ alias, canonical: tool.id, distance });
    }
    matches.sort(
      (left, right) =>
        left.distance - right.distance ||
        (left.canonical < right.canonical ? -1 : left.canonical > right.canonical ? 1 : 0),
    );
    return matches.slice(0, max).map(({ alias, canonical }) => ({ alias, canonical }));
  }

  all(): readonly T[] {
    return [...this.byId.values()];
  }

  ids(): readonly string[] {
    return [...this.byId.keys()];
  }
}
