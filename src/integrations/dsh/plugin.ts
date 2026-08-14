import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { RegisteredTool } from "../../tools/definition.js";
import { createMockGithubTools } from "../../tools/providers/github/mock.js";
import { createRealGithubTools } from "../../tools/providers/github/real.js";
import { createMockDomainTools } from "../../tools/providers/domain/mock.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { RuntimeRegistry } from "../../runtime/runtime.js";
import type { DslGuidanceMode } from "../pi/dslReference.js";
import { DEFAULT_DSL_GUIDANCE, renderDslReference } from "../pi/dslReference.js";
import { adaptRegisteredTool } from "./toolAdapter.js";
import { createDshJitTools } from "./jitTools.js";

/**
 * Agent JIT 的 DSH 插件（Cordis 插件形态）。
 *
 * apply(ctx, config) 完成三件事：
 * 1. 按 config.providers 构建 agent-jit ToolRegistry（github real/mock +
 *    domain mock，工具契约与 Pi 集成同一事实源 contracts.ts）；
 * 2. 把每个工具注册进 ctx.tools（name = host alias，description 注入实验
 *    验证的函数式 DSL 签名——普通调用看 parameters，JIT 编程看 DSL: 签名）；
 * 3. 注册 jit_describe_tools / jit_execute_program 元工具（jit_execute_program
 *    编译并执行 DSL 程序；配置开启的 DSH 宿主工具经嵌套分发可被 DSL 编排）。
 * 可选：把 DSL 语言参考（primitive/patterns/full-example）挂进 system prompt
 * 的 section（缺省 primitive——最少信息已达 100% offload precision）。
 *
 * 所有注册都经 ctx（cordis effect 化），插件卸载时自动清理。
 */

export const name = "agent-jit-dsl";

export const inject = ["tools", "systemPrompt"];

/** DSL 语言参考 section 的排序（tool 指引 100-199 之后）。 */
const DSL_GUIDANCE_SECTION_ORDER = 350;

export interface AgentJitDshConfig {
  /** 业务工具 provider 选择（缺省全部 mock，确定性、无外部依赖）。 */
  providers?: {
    github?: "mock" | "real" | "none";
    domain?: "mock" | "none";
  };
  dsl?: {
    /** 是否在 provider tool description 注入 DSL 签名（缺省 inline，实验验证格式）。 */
    signatureInDescription?: "inline" | "none";
    /** 是否常驻 system prompt 的 DSL 语言参考（缺省 true，primitive 模式）。 */
    systemPrompt?: boolean;
    /** DSL 语言参考模式：primitive / patterns / full-example。 */
    guidance?: DslGuidanceMode;
    /** 是否注册 jit_describe_tools（缺省 true）。 */
    describeTools?: boolean;
  };
  /**
   * 暴露给 DSL 程序的 DSH 宿主工具名（DSH 原名，如 "run_bash"）。
   * 这些工具经 ctx.tools.execute 嵌套分发执行，走完整策略管线
   * （guard / pre-execute / post-execute / 超时 / 沙箱）。
   */
  hostTools?: string[];
}

/** 构建 agent-jit ToolRegistry：github（real/mock）+ domain（mock）。 */
function buildRegistry(config: AgentJitDshConfig): ToolRegistry<RegisteredTool> {
  const providers = config.providers ?? {};
  const tools: RegisteredTool[] = [];
  if (providers.github !== "none") {
    tools.push(
      ...(providers.github === "real" ? createRealGithubTools() : createMockGithubTools()),
    );
  }
  if (providers.domain !== "none") {
    tools.push(...createMockDomainTools());
  }
  return new ToolRegistry<RegisteredTool>(tools);
}

export function apply(ctx: Context, config: AgentJitDshConfig = {}): void {
  const registry: RuntimeRegistry = buildRegistry(config);
  const dsl = config.dsl ?? {};

  // 1. 业务工具 → DSH 工具（host alias 名 + description 注入 DSL 函数式签名）。
  for (const tool of registry.all()) {
    ctx.tools.register(adaptRegisteredTool(tool, { dslSignature: dsl.signatureInDescription ?? "inline" }));
  }

  // 2. 宿主工具（DSH 自身工具，供 DSL 程序编排）。
  const hostTools: ToolDefinition[] = [];
  for (const hostName of config.hostTools ?? []) {
    const definition = ctx.tools.get(hostName);
    if (definition === undefined) {
      throw new Error(`agent-jit-dsl: hostTools 引用了未注册的 DSH 工具 ${JSON.stringify(hostName)}`);
    }
    hostTools.push(definition);
  }

  // 3. JIT 元工具（jit_describe_tools / jit_execute_program）。
  for (const metaTool of createDshJitTools(registry, ctx.tools, {
    guidance: dsl.guidance ?? DEFAULT_DSL_GUIDANCE,
    describeTools: dsl.describeTools,
    hostTools,
  })) {
    ctx.tools.register(metaTool);
  }

  // 4. 可选：DSL 语言参考 section（primitive 为生产默认）。
  if (dsl.systemPrompt !== false) {
    ctx.systemPrompt.section({
      name: "agent-jit-dsl",
      order: DSL_GUIDANCE_SECTION_ORDER,
      text: () => renderDslReference(dsl.guidance ?? DEFAULT_DSL_GUIDANCE),
    });
  }
}
