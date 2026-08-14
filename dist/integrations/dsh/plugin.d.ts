import type { Context } from "@deepseek-ai/cordis";
import type { DslGuidanceMode } from "../pi/dslReference.js";
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
export declare const name = "agent-jit-dsl";
export declare const inject: string[];
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
export declare function apply(ctx: Context, config?: AgentJitDshConfig): void;
