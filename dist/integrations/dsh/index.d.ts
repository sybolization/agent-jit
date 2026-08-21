/**
 * DSH 插件入口（bundle 的 `main` 指向这里）。
 *
 * cordis.patch.yml 的行 `name: agent-jit/dsh` 解析到本模块；Loader 要求
 * 模块导出 Cordis 插件契约（name / inject / apply）。业务类型与工具工厂
 * 从各子模块导出，供测试与外部集成复用。
 */
export { name, inject, apply, type AgentJitDshConfig } from "./plugin.js";
export { createDshHarnessAdapter } from "./harnessAdapter.js";
export { adaptRegisteredTool, dshToolAsRegisteredTool, type DslToolCaller } from "./toolAdapter.js";
export { createDshJitDescribeTool, createDshJitExecuteProgramTool, createDshJitTools, type DshHostToolsConfig, type JitExecuteProgramDetails, } from "./jitTools.js";
export { HostToolView, unreachableHostCaller, type HostToolViewOptions } from "./hostDiscovery.js";
export { jsonSchemaFromTypebox, typeboxFromJsonSchema } from "./schema.js";
export { installRoutingReminder, RoutingReminderGate, containsList, buildListReminder, LIST_ROUTING_REMINDER, DEFAULT_REMINDER_EXCLUDE, type RoutingReminderMode, type RoutingReminderOptions, type ReminderExecView, type ReminderResultView, } from "./routingReminder.js";
