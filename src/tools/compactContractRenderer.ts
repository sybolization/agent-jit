import type { ToolContract } from "./definition.js";
import type { ToolCatalog } from "./registry.js";
import { schemaViewOf, schemaViewText, type SchemaView } from "./schemaView.js";

/**
 * Compact Output Manifest：只渲染 `canonical tool id → 输出形状` 的紧凑清单。
 *
 * 与 renderToolContracts（llmCatalog）的分工——同一个 registry 的另一个消费者：
 * - renderToolContracts：输入参数 + 命名输出类型 + 类型定义段（describe 场景，
 *   模型需要知道"怎么调、结构长什么样"）；
 * - renderCompactManifest（本文件）：**只**给输出形状（`{a: string, b: integer}`）——
 *   compact-manifest 实验的 Arm-C 处理：模型已经通过正常 tool-calling 通道看到
 *   工具名 / description / 输入参数，这里只补上缺失的输出形状，绝不重复其他信息。
 *
 * 约定：不做命名类型抽取（结构去重、类型定义段都交给 llmCatalog），
 * 不渲染 required / title / $id / description 等元数据，不出现输入参数 /
 * “参数格式”/“类型定义”等段——保持每行自包含。
 *
 * 历史兼容 renderer：本文件是历史兼容 renderer，新代码请使用 `dslSignature.ts` 的
 * `renderDslSignature`（forward-looking 的 DSL 签名层），不再在此新增渲染逻辑。
 */

/**
 * 从 output schema 的 property `description` 收集字段语义标签（opaque 工具用）：
 * 递归读取顶层 object（或 array 元素的 object）每个 property 的 description，
 * 非空字符串才收录，返回 `{字段名: description}`。transparent 工具无 description → 空表。
 */
function outputFieldLabels(schema: unknown): Record<string, string> {
  const labels: Record<string, string> = {};
  const collect = (node: unknown): void => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return;
    const raw = node as { type?: unknown; items?: unknown; properties?: Record<string, unknown> };
    if (raw.type === "array" && raw.items !== null && typeof raw.items === "object" && !Array.isArray(raw.items)) {
      collect(raw.items);
      return;
    }
    if (raw.type === "object") {
      for (const [key, prop] of Object.entries(raw.properties ?? {})) {
        if (prop !== null && typeof prop === "object" && !Array.isArray(prop)) {
          const description = (prop as { description?: unknown }).description;
          if (typeof description === "string" && description.length > 0) {
            labels[key] = description;
          }
        }
      }
    }
  };
  collect(schema);
  return labels;
}

/** 把 SchemaView 渲染为单行输出形状：对象 `{a: string, b: integer}`、数组 `[...]`。
 *  labels（output schema property description）提供时，字段渲染为 `key: type[label]` 形态（最小语义标签）。 */
function outputShape(view: SchemaView, labels?: Readonly<Record<string, string>>): string {
  if (view.kind === "object") {
    const fields = Object.entries(view.properties)
      .map(([key, prop]) => {
        const hint = labels?.[key];
        return `${key}: ${schemaViewText(prop)}${hint !== undefined ? `[${hint}]` : ""}`;
      })
      .join(", ");
    return `{${fields}}`;
  }
  if (view.kind === "array") {
    // schemaViewOf 已把 items 未知的数组归一为 unknown，这里 items 必然可渲染
    return `[${outputShape(view.items, labels)}]`;
  }
  return schemaViewText(view); // primitive / record / union / unknown 内联渲染
}

/**
 * 渲染紧凑输出清单：`<canonical-id> -> <形状>`，一行一个工具。
 * ids 缺省时按 id 字典序输出全部工具；提供时保持给定顺序（去重）。
 * 只返回形状行（不含标题段）——标题由调用方（如 treatment 提示词的
 * `## Output manifest` 段）统一添加，保持 manifest 本身无任何 `# ` 行。
 */
export function renderCompactManifest(catalog: ToolCatalog, ids?: readonly string[]): string {
  let tools: readonly ToolContract[];
  if (ids === undefined) {
    tools = [...catalog.all()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  } else {
    // 子集渲染：保持请求顺序（去重），与 renderToolContracts 的 subset 逻辑一致
    const order = new Map<string, number>();
    for (const id of ids) if (!order.has(id)) order.set(id, order.size);
    tools = catalog
      .all()
      .filter((tool) => order.has(tool.id))
      .sort((left, right) => order.get(left.id)! - order.get(right.id)!);
  }
  return tools.map((tool) => `${tool.id} -> ${outputShape(schemaViewOf(tool.outputSchema), outputFieldLabels(tool.outputSchema))}`).join("\n");
}
