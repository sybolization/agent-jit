import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RegisteredTool } from "../../tools/definition.js";
import { type ToolRegistry } from "../../tools/registry.js";
import { createJitDescribeTool, createJitExecuteProgramTool } from "./jit.js";
import type { DslGuidanceMode } from "./dslReference.js";

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

/** 单个 RegisteredTool → AgentTool（name 用 host alias；execute 原样透传并序列化结果）。 */
export function adaptRegisteredTool(registry: ToolRegistry<RegisteredTool>, tool: RegisteredTool): AgentTool<any> {
  return {
    name: registry.hostName(tool.id),
    label: tool.label,
    description: tool.description ?? tool.label,
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
 * describeTools 缺省 true（挂 jit_describe_tools）；compile-only / manifest 臂传
 * describeTools:false——模型没有 describe 工具可用，只能直接写程序、靠编译诊断兜底。
 */
export function createPiTools(
  registry: ToolRegistry<RegisteredTool>,
  options: { guidance?: DslGuidanceMode; describeTools?: boolean } = {},
): AgentTool<any>[] {
  return [
    ...registry.all().map((tool) => adaptRegisteredTool(registry, tool)),
    ...(options.describeTools === false ? [] : [createJitDescribeTool(registry, options)]),
    createJitExecuteProgramTool(registry),
  ];
}
