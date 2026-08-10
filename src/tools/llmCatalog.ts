import type { ToolContract } from "./definition.js";
import type { ToolCatalog } from "./registry.js";
import { schemaViewOf, schemaViewText, type SchemaView } from "./schemaView.js";

/**
 * Compact LLM Catalog：把 tool registry 自动渲染成给模型的紧凑工具目录
 * （ToolRegistry 的第二个消费者，与 Compiler 并列）。
 *
 * 原则：**工具调用只需要 input contract；工具编排必须同时有 output contract。**
 * - 只渲染契约（inputSchema / outputSchema），绝不渲染真实返回内容或示例 JSON；
 * - 输出对象提取为命名类型（末尾"类型定义"段），**结构相同的类型只展示一次**；
 * - 渲染走 SchemaView 归一（string | null / 嵌套 / union / record），
 *   compiler 内部仍然使用完整 JSON Schema，这里只是给模型的紧凑投影。
 *
 * 两个消费入口：
 * - renderCompactToolCatalog：全量目录（把工具目录嵌入 prompt 的老通道）；
 * - renderToolContracts（子集）：jit_describe_tools 元工具的确定性渲染
 *   （模型点名若干工具 → 返回它们的 DSL 用法契约），见 src/tools/jitTools.ts。
 */

const VERB_PREFIXES = ["search", "get", "list", "prepare", "fetch", "create", "count", "find", "load"];

/** 末词单数化（仅覆盖常见规则：ies→y、尾 s→空；无法可靠处理的保持原样）。 */
function singularize(word: string): string {
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ss") || word.endsWith("us") || word.endsWith("is")) return word;
  if (word.endsWith("s") && word.length > 1) return word.slice(0, -1);
  return word;
}

function pascalCase(tokens: readonly string[]): string {
  return tokens.map((token) => (token ? token.charAt(0).toUpperCase() + token.slice(1) : "")).join("");
}

/**
 * 输出对象类型名优先来自 schema metadata：`schema.title` → `schema.$id` → heuristic fallback。
 * 数组取元素对象上的 metadata（RepositorySummary[] 的名字在元素 schema 上）；
 * 外部工具只要声明 title/$id 就能得到稳定类型名，不依赖命名启发式。
 */
function schemaTypeName(schema: unknown): string | undefined {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  const node = schema as { type?: unknown; items?: unknown; title?: unknown; $id?: unknown };
  if (node.type === "array") {
    const items = node.items;
    if (items !== null && typeof items === "object" && !Array.isArray(items)) {
      const item = items as { title?: unknown; $id?: unknown };
      if (typeof item.title === "string" && item.title.length > 0) return item.title;
      if (typeof item.$id === "string" && item.$id.length > 0) return item.$id;
    }
    return undefined;
  }
  if (typeof node.title === "string" && node.title.length > 0) return node.title;
  if (typeof node.$id === "string" && node.$id.length > 0) return node.$id;
  return undefined;
}

/**
 * 从工具 id 推导输出类型名：`github.search_repositories` → `RepositorySummary`；
 * 纯动词段（如 `email.prepare`）回退为 `<域名>Result`。
 */
function typeNameFor(id: string): string {
  const segments = id.split(".");
  const domain = segments[0] ?? "result";
  const tokens = (segments[segments.length - 1] ?? "").split("_").filter((token) => token.length > 0);
  let verb = "";
  while (tokens.length > 0 && VERB_PREFIXES.includes(tokens[0]!)) {
    verb = tokens.shift() as string;
  }
  let name: string;
  if (tokens.length > 0) {
    tokens[tokens.length - 1] = singularize(tokens[tokens.length - 1] ?? "");
    name = pascalCase(tokens);
  } else {
    name = `${pascalCase([domain])}Result`;
  }
  if (verb === "search") name += "Summary"; // 搜索返回的是摘要形态
  return name;
}

interface NamedType {
  name: string;
  fields: Record<string, SchemaView>;
}

/** 对象结构指纹：字段按名排序拼接（渲染文本相同即视为同一结构，共享一个类型名）。 */
function shapeKey(fields: Record<string, SchemaView>): string {
  return Object.entries(fields)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, view]) => `${key}:${schemaViewText(view)}`)
    .join(",");
}

/** 把命名类型注册表封装成"渲染输出类型"的闭包（array<object> → Name[]，结构去重）。 */
function outputRenderer(named: Map<string, NamedType>) {
  const register = (view: { kind: "object"; properties: Record<string, SchemaView> }, owner: ToolContract): string => {
    const key = shapeKey(view.properties);
    const existing = named.get(key);
    if (existing) return existing.name;
    const base = schemaTypeName(owner.outputSchema) ?? typeNameFor(owner.id);
    const taken = new Set([...named.values()].map((item) => item.name));
    let name = base;
    let suffix = 2;
    while (taken.has(name)) name = `${base}${suffix++}`; // 同名但结构不同 → 追加数字后缀
    named.set(key, { name, fields: view.properties });
    return name;
  };
  return (view: SchemaView, owner: ToolContract): string => {
    if (view.kind === "array" && view.items.kind === "object") return `${register(view.items, owner)}[]`;
    if (view.kind === "object") return register(view, owner);
    return schemaViewText(view); // 原始类型 / record / union / unknown 内联渲染
  };
}

function formatType(type: NamedType): string {
  const fields = Object.entries(type.fields)
    .map(([key, view]) => `  ${key}: ${schemaViewText(view)}`)
    .join("\n");
  return `${type.name} {\n${fields}\n}`;
}

export interface RenderToolContractsOptions {
  /** 只渲染这些 id 的工具；缺省渲染全部。提供时保持 ids 给出的顺序 */
  ids?: readonly string[];
  /** 与 pi-ai 工具定义的命名保持一致（如把 "github.search_repositories" 映射为 "github_search_repositories"） */
  nameTransform?: (id: string) => string;
  /** 覆盖目录标题行（如 "# Requested Tool Contracts"）；缺省用默认标题 */
  header?: string;
}

/** 渲染紧凑工具目录（可选子集）。nameTransform 用于与 pi-ai 工具定义的命名保持一致。 */
export function renderToolContracts(catalog: ToolCatalog, options: RenderToolContractsOptions = {}): string {
  const { ids, nameTransform = (id) => id } = options;
  let tools: readonly ToolContract[];
  if (ids === undefined) {
    tools = [...catalog.all()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  } else {
    // 子集渲染：保持请求顺序（去重），便于 describe_tools 按模型点名的顺序回显
    const order = new Map<string, number>();
    for (const id of ids) if (!order.has(id)) order.set(id, order.size);
    tools = catalog
      .all()
      .filter((tool) => order.has(tool.id))
      .sort((left, right) => order.get(left.id)! - order.get(right.id)!);
  }
  const named = new Map<string, NamedType>();
  const outputOf = outputRenderer(named);
  const header = options.header ?? `# 工具目录（紧凑签名）— 共 ${tools.length} 个`;

  const signatures = tools.map((tool) => {
    const inputView = schemaViewOf(tool.inputSchema);
    const required = inputView.kind === "object" ? new Set(inputView.required) : new Set<string>();
    const properties = inputView.kind === "object" ? inputView.properties : {};
    const params = Object.entries(properties)
      .map(([key, prop]) => `  ${key}${required.has(key) ? "" : "?"}: ${schemaViewText(prop)}`)
      .join("\n");
    const call = params.length > 0 ? `${nameTransform(tool.id)}(\n${params}\n)` : `${nameTransform(tool.id)}()`;
    const description = tool.description ? `  # ${tool.description}` : "";
    return `${call} -> ${outputOf(schemaViewOf(tool.outputSchema), tool)}${description}`;
  });

  const signatureBlock = signatures.join("\n\n");
  const typeBlock =
    named.size > 0
      ? `\n\n## 类型定义（结构相同的类型只展示一次）\n\n${[...named.values()].map(formatType).join("\n\n")}`
      : "";

  return [
    header,
    "# 参数格式：<名称>: <类型>（? = 可选）；输出为命名类型，定义见下方“类型定义”段",
    "",
    signatureBlock + typeBlock,
  ].join("\n");
}

/** 渲染完整工具目录（ToolRegistry 的 LLM Catalog 消费者入口；子集见 renderToolContracts）。 */
export function renderCompactToolCatalog(
  catalog: ToolCatalog,
  nameTransform: (id: string) => string = (id) => id,
): string {
  return renderToolContracts(catalog, { nameTransform });
}
