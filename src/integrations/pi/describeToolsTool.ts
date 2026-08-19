import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RuntimeRegistry } from "../../runtime/runtime.js";
import {
  DESCRIBE_TOOLS_TOOL,
  describeToolContracts,
  type DescribeContractFormat,
} from "../../tools/jitTools.js";
import {
  describeProgramDescription,
  renderRoutingDslReference,
  type DescribeDslReferenceMode,
  type RoutingPromptVariant,
} from "../../prompt/routingToolPrompts.js";
import { DEFAULT_DSL_GUIDANCE, renderDslReference, type DslGuidanceMode } from "./dslReference.js";
import { renderCompositionBindings } from "../../tools/compositionHints.js";

/**
 * DSL manual 按需加载：不常驻 system prompt，由 jit_describe_tools **第一次**调用时
 * 随契约文本一并返回（与"工具 contract 可以 lazy load"同一设计原则）。
 * 内容由 dslReference.ts 的 renderDslReference(guidance) 按 guidance 模式渲染：
 * primitive → 核心三层参考（1. Tool calls / 2. Array dataflow operators / 3. Return）；
 * patterns → 核心参考 + 组合模式；full-example → 核心参考 + 端到端示例。
 * 组合模式只使用通用变量名与 service.* 通用服务名，不内嵌任何业务工具契约或任务常量。
 */

/** 与 describeToolContracts 一致的解析：tool_names（canonical / host alias）→ 去重后的 canonical id 列表。 */
function resolveCanonicalIds(catalog: RuntimeRegistry, toolNames: readonly string[]): string[] {
  const ids: string[] = [];
  for (const name of [...new Set(toolNames.map((name) => name.trim()).filter((name) => name.length > 0))]) {
    const canonical = catalog.resolveId(name);
    if (canonical !== undefined && !ids.includes(canonical)) ids.push(canonical);
  }
  return ids;
}

/** jit_describe_tools 工具：tool_names → 确定性 DSL 契约文本。
 *
 * 两个正交选项（production 缺省最简）：
 * - describeFormat："signature"（缺省，与 active tool 内联签名同源）| "legacy"（历史四段式）；
 * - legacyBundle：false（缺省）= **纯契约 discovery**，不捆绑 DSL manual 与组合 bindings
 *   （DSL 语言参考由 stable system context 提供）；true = 历史 eager 臂行为
 *   （首次调用附带 manual、patterns 模式附带 bindings），仅供历史实验复现。
 */
export function createJitDescribeTool(
  registry: RuntimeRegistry,
  options: {
    guidance?: DslGuidanceMode;
    describeFormat?: DescribeContractFormat;
    legacyBundle?: boolean;
    routingPrompt?: RoutingPromptVariant;
    describeDslReference?: DescribeDslReferenceMode;
  } = {},
): AgentTool<typeof DESCRIBE_TOOLS_TOOL.parameters> {
  let describeCalls = 0;
  const guidance = options.guidance ?? DEFAULT_DSL_GUIDANCE;
  // 历史 eager 臂传 "legacy"（llmCatalog 四段式，逐字节复现历史输出）；
  // production（eager-signatures）缺省 "signature"——与 active tool 内联签名同源。
  const describeFormat = options.describeFormat ?? "signature";
  const legacyBundle = options.legacyBundle === true;
  let routingReferenceReturned = false;
  return {
    ...DESCRIBE_TOOLS_TOOL,
    ...(options.routingPrompt === undefined
      ? {}
      : { description: describeProgramDescription(options.routingPrompt) }),
    label: "Describe DSL tool contracts",
    execute: async (_toolCallId, params) => {
      const toolNames = (params as { tool_names: string[] }).tool_names;
      let text = describeToolContracts(registry, toolNames, {
        header: "# Requested Tool Contracts",
        format: describeFormat,
      });
      // 严格语义：任一 id 未知 → 整体失败（UNKNOWN_TOOL 全列 + 建议），抛给 Agent 转 toolResult
      if (text.startsWith("错误")) throw new Error(text);
      if (!legacyBundle) {
        // R7 lazy-manual: production pure contracts + first-call neutral manual.
        if (options.describeDslReference === 'first-call' && !routingReferenceReturned) {
          routingReferenceReturned = true;
          text = `${renderRoutingDslReference()}\n\n${text}`;
        }
        // production：纯契约，不捆绑语言教学（manual 由 stable system context 提供）
        return {
          content: [{ type: "text", text }],
          details: { toolNames: (params as { tool_names: string[] }).tool_names },
        };
      }
      describeCalls += 1;
      // 历史 eager 臂：本次请求工具集合的局部兼容连接（仅 patterns 模式）
      const canonicalIds = resolveCanonicalIds(registry, toolNames);
      const bindings = guidance === "patterns" ? renderCompositionBindings(registry, canonicalIds) : "";
      // DSL manual 按需加载：第一次 describe 顺带返回语法参考（按 guidance 模式渲染），之后不再重复
      if (describeCalls === 1) text = `${renderDslReference(guidance)}\n\n${text}`;
      if (bindings.length > 0) text = `${text}\n\n${bindings}`;
      return {
        content: [{ type: "text", text }],
        details: { toolNames: (params as { tool_names: string[] }).tool_names },
      };
    },
  };
}
