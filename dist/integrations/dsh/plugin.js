import { createMockGithubTools } from "../../tools/providers/github/mock.js";
import { createRealGithubTools } from "../../tools/providers/github/real.js";
import { createMockDomainTools } from "../../tools/providers/domain/mock.js";
import { ToolRegistry } from "../../tools/registry.js";
import { DEFAULT_DSL_GUIDANCE, renderDslReference, renderNeutralDslReference } from "../pi/dslReference.js";
import { adaptRegisteredTool } from "./toolAdapter.js";
import { createDshJitTools } from "./jitTools.js";
import { installRoutingReminder } from "./routingReminder.js";
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
/** 构建 agent-jit ToolRegistry：github（real/mock）+ domain（mock）。 */
function buildRegistry(config) {
    const providers = config.providers ?? {};
    const tools = [];
    if (providers.github !== "none") {
        tools.push(...(providers.github === "real" ? createRealGithubTools() : createMockGithubTools()));
    }
    if (providers.domain !== "none") {
        tools.push(...createMockDomainTools());
    }
    return new ToolRegistry(tools);
}
export function apply(ctx, config = {}) {
    // 实验业务工具只在 experimentMode: true 时构建（生产缺省空 registry）。
    const registry = config.experimentMode === true ? buildRegistry(config) : new ToolRegistry();
    const dsl = config.dsl ?? {};
    // 生产默认（R7 胜出臂 T3）：不挂 system prompt；jit_execute_program 自描述。
    const routingPrompt = dsl.routingPrompt ?? "tool-embedded";
    const describeDslReference = dsl.describeDslReference ?? "none";
    const systemPromptEnabled = dsl.systemPrompt === true;
    // 1. 业务工具 → DSH 工具（host alias 名 + description 注入 DSL 函数式签名；仅实验模式）。
    for (const tool of registry.all()) {
        ctx.tools.register(adaptRegisteredTool(tool, { dslSignature: dsl.signatureInDescription ?? "inline" }));
    }
    // 2. 宿主工具开放配置：缺省自动发现全部；[] 关闭；非空 = 白名单。
    const hostTools = {
        ...(config.hostTools === undefined ? {} : { allow: config.hostTools }),
        ...(config.excludeHostTools === undefined ? {} : { exclude: config.excludeHostTools }),
    };
    // 3. JIT 元工具（jit_describe_tools / jit_execute_program）。
    for (const metaTool of createDshJitTools(registry, ctx.tools, {
        describeTools: dsl.describeTools,
        hostTools,
        routingPrompt,
        describeDslReference,
    })) {
        ctx.tools.register(metaTool);
    }
    // 4. 可选：DSL 语言参考 section（生产默认关闭；显式 systemPrompt:true 才挂，neutral 为默认）。
    if (systemPromptEnabled) {
        ctx.systemPrompt.section({
            name: "agent-jit-dsl",
            order: DSL_GUIDANCE_SECTION_ORDER,
            text: () => dsl.systemPromptReference === "standard"
                ? renderDslReference(dsl.guidance ?? DEFAULT_DSL_GUIDANCE)
                : renderNeutralDslReference(),
        });
    }
    // 5. 可选：soft hook —— 工具返回列表后注入"考虑 JIT"提醒（生产默认关闭）。
    if (dsl.routingReminder === "on-list") {
        installRoutingReminder(ctx, { minListLength: dsl.routingReminderMinListLength ?? 2 });
    }
}
