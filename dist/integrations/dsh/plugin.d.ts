import type { Context } from "@deepseek-ai/cordis";
import type { DslGuidanceMode } from "../pi/dslReference.js";
import type { DescribeDslReferenceMode, RoutingPromptVariant } from "../../prompt/routingToolPrompts.js";
import { type RoutingReminderMode } from "./routingReminder.js";
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
        /**
         * 是否常驻 system prompt 的 DSL 语言参考。
         * 生产默认 false（R7 T3 结论：工具面自描述即可恢复路由）；
         * 显式 true 时挂 section。
         */
        systemPrompt?: boolean;
        /** DSL 语言参考模式：primitive / patterns / full-example（仅 systemPrompt:true 时使用）。 */
        guidance?: DslGuidanceMode;
        /**
         * systemPrompt:true 时的参考文案：neutral（生产默认，只用 service.* 占位符）
         * | standard（历史 primitive 参考，含 GitHub 示例，仅复现实验用）。
         */
        systemPromptReference?: "standard" | "neutral";
        /** 是否注册 jit_describe_tools（缺省 true）。 */
        describeTools?: boolean;
        /**
         * jit_* 工具描述文案变体。生产默认 tool-embedded（R7 胜出臂：
         * when/why trigger + 完整中性 DSL manual 进 execute 描述）。
         */
        routingPrompt?: RoutingPromptVariant;
        /** describe 是否附带中性 DSL 参考（生产默认 none；first-call 为历史 lazy 臂）。 */
        describeDslReference?: DescribeDslReferenceMode;
        /**
         * soft hook：某工具返回列表结果后，向下一次模型输入追加一条"考虑 JIT"的
         * 提醒（advisory，模型可忽略）。生产默认 on-list（开启）；显式 none 关闭。
         */
        routingReminder?: RoutingReminderMode;
        /** 触发 routingReminder 的最小列表长度（缺省 2）。 */
        routingReminderMinListLength?: number;
        /** 排除不触发提醒的工具名（支持 `*` 通配符；缺省 read/read_image，见 DEFAULT_REMINDER_EXCLUDE）。 */
        routingReminderExclude?: readonly string[];
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
