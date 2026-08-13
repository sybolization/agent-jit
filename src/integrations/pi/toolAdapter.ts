import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RegisteredTool } from "../../tools/definition.js";
import { type ToolRegistry } from "../../tools/registry.js";
import { createJitDescribeTool } from "./describeToolsTool.js";
import { createJitExecuteProgramTool } from "./executeProgramTool.js";
import { dslSignatureOf, renderDslSignature } from "../../tools/dslSignature.js";
import type { DslGuidanceMode } from "./dslReference.js";
import type { DslDiagnostic } from "../../language/diagnostics.js";

/**
 * ToolRegistry → Pi AgentTool 适配层。
 *
 * 目标形态（Pi Agent 拥有全部可执行工具，统一由 agent loop 调度）：
 *
 * ```text
 * ToolRegistry
 *     ↓
 * createPiTools(registry)
 *     ↓
 * Pi Agent
 *   ├─ github_search_repositories   （普通业务工具：host alias 名，execute → 原 RegisteredTool.execute）
 *   ├─ github_get_repository
 *   ├─ ...
 *   ├─ jit_describe_tools           （→ registry → renderToolContracts）
 *   └─ jit_execute_program          （→ compileExecutionDsl → execute(graph, 同一 registry) → result）
 * ```
 *
 * 普通工具只改名字（canonical → host alias）与执行签名（RegisteredTool.execute(input) →
 * AgentTool.execute(toolCallId, params)），语义零改动；失败照常 throw，由 Agent 转 isError。
 */

/** adaptRegisteredTool 的 DSL signature 注入开关：none = 不注入（历史实验基线）；inline = 追加一行 DSL 签名。 */
export type DslSignatureMode = "none" | "inline";

export interface PiToolAdapterOptions {
  dslSignature?: DslSignatureMode;
}

/** 单个 RegisteredTool → AgentTool（name 用 host alias；execute 原样透传并序列化结果）。
 *  DSL signature 是否注入由 `options.dslSignature` 显式决定（缺省 none，保证历史实验的
 *  contract visibility 隔离——只有 eager-signatures / production 才开 inline）。 */
export function adaptRegisteredTool(
  registry: ToolRegistry<RegisteredTool>,
  tool: RegisteredTool,
  options: PiToolAdapterOptions = {},
): AgentTool<any> {
  const description =
    options.dslSignature === "inline"
      ? `${tool.description ?? tool.label}\nDSL: ${renderDslSignature(dslSignatureOf(tool), { fieldLabels: true })}`
      : (tool.description ?? tool.label);
  return {
    name: registry.hostName(tool.id),
    label: tool.label,
    description,
    parameters: tool.inputSchema,
    execute: async (_toolCallId, params) => {
      const result = await tool.execute(params);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
    },
  };
}

/**
 * 把整个 registry 变成 Pi Agent 的工具集：普通业务工具（host alias 名）+ JIT 元工具。
 * Agent/agent loop 负责工具调用循环——harness 不需要再对 jit_* 做特殊 dispatch。
 *
 * 三个正交开关（缺省都是 false，保持历史实验的 contract visibility 隔离）：
 * - describeTools：挂 jit_describe_tools（optional discovery；历史 eager 流程显式开 true）；
 * - dslSignatures：给 active 工具 description 注入 inline DSL signature（eager-signatures / production 开 true）。
 */
export function createPiTools(
  registry: ToolRegistry<RegisteredTool>,
  options: {
    guidance?: DslGuidanceMode;
    describeTools?: boolean;
    dslSignatures?: boolean;
    onCompileFailure?: (diagnostics: readonly DslDiagnostic[]) => void;
  } = {},
): AgentTool<any>[] {
  return [
    ...registry.all().map((tool) =>
      adaptRegisteredTool(registry, tool, options.dslSignatures === true ? { dslSignature: "inline" } : {}),
    ),
    ...(options.describeTools === true ? [createJitDescribeTool(registry, options)] : []),
    createJitExecuteProgramTool(registry, options),
  ];
}
