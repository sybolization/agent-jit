import { type RegisteredTool, type ToolContract } from "../../definition.js";
/**
 * 跨域 mock 工具（domain provider，契约 + execute）：
 * - crm.search_customers / crm.get_customer：单字段**异名**绑定（id → customer_id）；
 * - users.list_users / email.prepare：多字段绑定（email/name → to/name）。
 */
export declare const mockDomainToolSpecs: readonly ToolContract[];
export declare function createMockDomainTools(): RegisteredTool[];
