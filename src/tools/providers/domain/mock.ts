import { Type } from "typebox";
import { defineTool, type RegisteredTool, type ToolContract } from "../../definition.js";

/**
 * 跨域 mock 工具（domain provider，契约 + execute）：
 * - crm.search_customers / crm.get_customer：单字段**异名**绑定（id → customer_id）；
 * - users.list_users / email.prepare：多字段绑定（email/name → to/name）。
 */
export const mockDomainToolSpecs: readonly ToolContract[] = [
  defineTool({
    id: "crm.search_customers",
    label: "Search CRM customers",
    description: "按条件搜索客户，返回客户列表。",
    inputSchema: Type.Object({ limit: Type.Optional(Type.Integer()) }, { additionalProperties: false }),
    outputSchema: Type.Array(
      Type.Object({ id: Type.String(), name: Type.String() }, { additionalProperties: false }),
    ),
  }),
  defineTool({
    id: "crm.get_customer",
    label: "Get a customer",
    description: "按 customer_id 获取单个客户详情。",
    inputSchema: Type.Object({ customer_id: Type.String() }, { additionalProperties: false }),
    outputSchema: Type.Object(
      { id: Type.String(), name: Type.String() },
      { additionalProperties: false },
    ),
  }),
  defineTool({
    id: "users.list_users",
    label: "List users",
    description: "返回用户列表。",
    inputSchema: Type.Object({}, { additionalProperties: false }),
    outputSchema: Type.Array(
      Type.Object(
        { id: Type.String(), email: Type.String(), name: Type.String() },
        { additionalProperties: false },
      ),
    ),
  }),
  defineTool({
    id: "email.prepare",
    label: "Prepare an email",
    description: "构造一封邮件（收件人 + 姓名）。",
    inputSchema: Type.Object(
      { to: Type.String(), name: Type.String() },
      { additionalProperties: false },
    ),
    outputSchema: Type.Object(
      { to: Type.String(), name: Type.String() },
      { additionalProperties: false },
    ),
  }),
];

export function createMockDomainTools(): RegisteredTool[] {
  const customers = Array.from({ length: 6 }, (_, i) => ({ id: `cust-${i + 1}`, name: `Customer ${i + 1}` }));
  const users = Array.from({ length: 6 }, (_, i) => ({ id: `user-${i + 1}`, email: `user${i + 1}@example.com`, name: `User ${i + 1}` }));
  return [
    { ...mockDomainToolSpecs[0]!, execute: async () => customers },
    { ...mockDomainToolSpecs[1]!, execute: async (args) => customers.find((c) => c.id === (args as Record<string, unknown>).customer_id) ?? customers[0] },
    { ...mockDomainToolSpecs[2]!, execute: async () => users },
    {
      ...mockDomainToolSpecs[3]!,
      execute: async (args) => ({ to: (args as Record<string, unknown>).to, name: (args as Record<string, unknown>).name }),
    },
  ];
}
