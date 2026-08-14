import { createMockGithubTools } from "../../tools/providers/github/mock.js";
import { createRealGithubTools } from "../../tools/providers/github/real.js";
import { createMockDomainTools } from "../../tools/providers/domain/mock.js";
import { ToolRegistry } from "../../tools/registry.js";
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
    const registry = buildRegistry(config);
    const dsl = config.dsl ?? {};
    // 1. 业务工具 → DSH 工具（host alias 名 + description 注入 DSL 函数式签名）。
    for (const tool of registry.all()) {
        ctx.tools.register(adaptRegisteredTool(tool, { dslSignature: dsl.signatureInDescription ?? "inline" }));
    }
    // 2. 宿主工具（DSH 自身工具，供 DSL 程序编排）。
    const hostTools = [];
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
