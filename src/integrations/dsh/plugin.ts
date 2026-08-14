import type { Context } from "@deepseek-ai/cordis";
import type { ToolRuntime } from "@deepseek-ai/dsh-tools";
import type { RegisteredTool } from "../../tools/definition.js";
import { createMockGithubTools } from "../../tools/providers/github/mock.js";
import { createRealGithubTools } from "../../tools/providers/github/real.js";
import { createMockDomainTools } from "../../tools/providers/domain/mock.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { RuntimeRegistry } from "../../runtime/runtime.js";
import type { DslGuidanceMode } from "../pi/dslReference.js";
import { DEFAULT_DSL_GUIDANCE, renderDslReference } from "../pi/dslReference.js";
import { adaptRegisteredTool } from "./toolAdapter.js";
import { createDshJitTools, type DshHostToolsConfig } from "./jitTools.js";

/**
 * Agent JIT 的 DSH 插件（Cordis 插件形态）。
 *
 * apply(ctx, config) 完成三件事：
 * 1. 按 config.providers 构建 agent-jit ToolRegistry（github real/mock +
 *    domain mock，工具契约与 Pi 集成同一事实源 contracts.ts）；
 * 2. 把每个工具注册进 ctx.tools（name = host alias，description 注入实验
 *    验证的函数式 DSL 签名——普通调用看 parameters，JIT 编程看 DSL: 签名）；
 * 3. 注册 jit_describe_tools / jit_execute_program 元工具（jit_execute_program
 *    编译并执行 DSL 程序；DSH 宿主工具经 hostDiscovery 活视图在运行时
 *    自动发现——任何注册进 ctx.tools 的工具 describe 即用、DSL 直接可编排，
 *    零配置；可选用 allow 白名单 / exclude 黑名单收紧）。
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
  /**
   * 实验模式：true = 注册实验业务工具（github_* / crm_* / users_* / email_*，
   * 默认 mock provider，供 R5/R6 benchmark 与演示任务使用）。
   *
   * 缺省 false（生产）**不注册任何业务工具**——插件使用者只拿到
   * jit_describe_tools / jit_execute_program 两个元工具，自己注册进 DSH
   * 的工具经 hostDiscovery 活视图零配置即可被 DSL 编排。实验工具绝不
   * 污染普通使用者的工具面。
   */
  experimentMode?: boolean;
  /** 业务工具 provider 选择（仅实验模式生效；缺省全部 mock，确定性、无外部依赖）。 */
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
   * DSL 程序可编排的 DSH 宿主工具（ctx.tools 里已注册的工具）。
   *
   * 缺省（undefined）**自动发现全部**：任何注册进 ctx.tools 的工具
   * （其他插件 / 动态注册）describe 即用、DSL 直接可编排，零配置。
   * 显式传 [] 关闭宿主工具；传名字数组 = 白名单。
   * 宿主工具经 ctx.tools.execute 嵌套分发，走完整策略管线
   * （guard / pre-execute / post-execute / 超时 / 沙箱）。
   */
  hostTools?: string[];
  /** 宿主工具黑名单：始终排除（白名单之外的第二道闸，如不想开放 bash 给 DSL）。 */
  excludeHostTools?: string[];
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
  // 实验业务工具只在 experimentMode: true 时构建（生产缺省空 registry）。
  const registry: RuntimeRegistry = config.experimentMode === true ? buildRegistry(config) : new ToolRegistry<RegisteredTool>();
  const dsl = config.dsl ?? {};

  // 1. 业务工具 → DSH 工具（host alias 名 + description 注入 DSL 函数式签名；仅实验模式）。
  for (const tool of registry.all()) {
    ctx.tools.register(adaptRegisteredTool(tool, { dslSignature: dsl.signatureInDescription ?? "inline" }));
  }

  // 2. 宿主工具开放配置：缺省自动发现全部；[] 关闭；非空 = 白名单。
  const hostTools: DshHostToolsConfig = {
    ...(config.hostTools === undefined ? {} : { allow: config.hostTools }),
    ...(config.excludeHostTools === undefined ? {} : { exclude: config.excludeHostTools }),
  };

  // 3. JIT 元工具（jit_describe_tools / jit_execute_program）。
  for (const metaTool of createDshJitTools(registry, ctx.tools as ToolRuntime, {
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
