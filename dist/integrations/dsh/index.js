/**
 * DSH 插件入口（bundle 的 `main` 指向这里）。
 *
 * cordis.patch.yml 的行 `name: agent-jit/dsh` 解析到本模块；Loader 要求
 * 模块导出 Cordis 插件契约（name / inject / apply）。业务类型与工具工厂
 * 从各子模块导出，供测试与外部集成复用。
 */
export { name, inject, apply } from "./plugin.js";
export { adaptRegisteredTool, dshToolAsRegisteredTool } from "./toolAdapter.js";
export { createDshJitDescribeTool, createDshJitExecuteProgramTool, createDshJitTools, } from "./jitTools.js";
export { HostToolView, unreachableHostCaller } from "./hostDiscovery.js";
export { jsonSchemaFromTypebox, typeboxFromJsonSchema } from "./schema.js";
export { installRoutingReminder, RoutingReminderGate, containsList, buildListReminder, LIST_ROUTING_REMINDER, DEFAULT_REMINDER_EXCLUDE, } from "./routingReminder.js";
