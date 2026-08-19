import { Type } from "typebox";
import { defineTool, type RegisteredTool } from "../tools/definition.js";
import type { TaskSpec } from "./taskSpec.js";
import { R5_TASKS, type R5Task } from "./r5Tasks.js";

/** R7 任务 id：A/B 来自 R5 development；H 是 holdout shipment 域。 */
export type R7TaskId = "A" | "B" | "H";

/** R7 任务类型：H 不属于 R5TaskId，因此 id 拓宽；其余字段与 R5Task 相同。 */
export type R7Task = Omit<R5Task, "id"> & { id: R7TaskId };

/**
 * R7 — Zero-Prompt Routing 任务集。
 *
 * - development：复用 R5 的 A（不值得 JIT）与 B（明显值得 JIT）；
 * - holdout H：全新工具域（shipment/物流），map binding 使用**异名 + 多字段**
 *   （order_id → order_no、country → country），数据流为两阶段依赖 fanout。
 *   H 的工具名/字段/常量与 development 的 GitHub 域完全隔离，用于检验
 *   routing prompt 不是只在 benchmark 工具面上过拟合。
 */

// ---------------------------------------------------------------------------
// Development
// ---------------------------------------------------------------------------

export function r7DevelopmentTasks(): readonly R7Task[] {
  return R5_TASKS.filter((task) => task.id === "A" || task.id === "B").map((task) => task as R7Task);
}

// ---------------------------------------------------------------------------
// Holdout H：shipment domain
// ---------------------------------------------------------------------------

interface HShipmentRow {
  order_id: string;
  customer_id: string;
  country: string;
  eta_days: number;
  status: "active" | "delayed";
}

const H_QUERY = "international";
const H_LIMIT = 12;
const H_TAKE_COUNT = 3;
const H_MAX_ETA_DAYS = 7;

const H_SHIPMENTS: readonly HShipmentRow[] = [
  { order_id: "ORD-3001", customer_id: "C-101", country: "DE", eta_days: 3, status: "active" },
  { order_id: "ORD-3002", customer_id: "C-102", country: "FR", eta_days: 5, status: "active" },
  { order_id: "ORD-3003", customer_id: "C-103", country: "NL", eta_days: 2, status: "active" },
  { order_id: "ORD-3004", customer_id: "C-104", country: "DE", eta_days: 9, status: "active" },
  { order_id: "ORD-3005", customer_id: "C-105", country: "IT", eta_days: 4, status: "delayed" },
  { order_id: "ORD-3006", customer_id: "C-106", country: "ES", eta_days: 6, status: "active" },
  { order_id: "ORD-3007", customer_id: "C-107", country: "DE", eta_days: 7, status: "active" },
  { order_id: "ORD-3008", customer_id: "C-108", country: "FR", eta_days: 8, status: "active" },
  { order_id: "ORD-3009", customer_id: "C-109", country: "NL", eta_days: 1, status: "active" },
  { order_id: "ORD-3010", customer_id: "C-110", country: "PL", eta_days: 10, status: "delayed" },
  { order_id: "ORD-3011", customer_id: "C-111", country: "SE", eta_days: 5, status: "active" },
  { order_id: "ORD-3012", customer_id: "C-112", country: "BE", eta_days: 7, status: "active" },
];

function buildHTools(): RegisteredTool[] {
  const searchOrders = defineTool({
    id: "shipment.search_orders",
    label: "Search international orders",
    description: "按查询条件搜索国际订单，返回订单号、客户号与目的国。",
    inputSchema: Type.Object({ query: Type.String(), limit: Type.Integer() }),
    outputSchema: Type.Array(
      Type.Object({
        order_id: Type.String({ description: "订单号" }),
        customer_id: Type.String({ description: "客户号" }),
        country: Type.String({ description: "目的国" }),
      }),
    ),
  });
  const getTracking = defineTool({
    id: "shipment.get_tracking",
    label: "Get shipment tracking",
    description: "按订单号与目的国查询物流跟踪，返回预计到达天数、状态与优先级。",
    inputSchema: Type.Object({
      order_no: Type.String({ description: "订单号" }),
      country: Type.String({ description: "目的国" }),
    }),
    outputSchema: Type.Object({
      order_id: Type.String({ description: "订单号" }),
      eta_days: Type.Integer({ description: "预计到达天数" }),
      status: Type.Enum(["active", "delayed"], { description: "物流状态" }),
      priority: Type.String({ description: "优先级" }),
    }),
  });
  return [
    {
      ...searchOrders,
      execute: async (input) => {
        const params = input as { limit: number };
        return H_SHIPMENTS.slice(0, params.limit).map((row) => ({
          order_id: row.order_id,
          customer_id: row.customer_id,
          country: row.country,
        }));
      },
    },
    {
      ...getTracking,
      execute: async (input) => {
        const params = input as { order_no: string; country: string };
        const row = H_SHIPMENTS.find(
          (item) => item.order_id === params.order_no && item.country === params.country,
        );
        if (!row) throw new Error(`未找到订单：${params.order_no}/${params.country}`);
        return {
          order_id: row.order_id,
          eta_days: row.eta_days,
          status: row.status,
          priority: row.eta_days <= 3 ? "express" : "standard",
        };
      },
    },
  ];
}

export function computeR7HGroundTruth(): string[] {
  return H_SHIPMENTS
    .filter((row) => row.status === "active" && row.eta_days <= H_MAX_ETA_DAYS)
    .sort((a, b) => a.eta_days - b.eta_days || a.order_id.localeCompare(b.order_id))
    .slice(0, H_TAKE_COUNT)
    .map((row) => row.order_id);
}

export const R7_H_SPEC: TaskSpec = {
  sourceTool: "shipment.search_orders",
  query: H_QUERY,
  queryTokens: [H_QUERY],
  limit: H_LIMIT,
  takeCount: H_TAKE_COUNT,
  // 防 overfit 关键：异名 + 多字段 binding，和 B 的同名单字段不同。
  bindings: { order_no: "order_id", country: "country" },
  stageTools: ["shipment.get_tracking"],
  sortKey: "eta_days",
  sortDesc: false,
  answerField: "order_id",
};

export function createR7HTask(): R7Task {
  return {
    id: "H",
    name: "shipment-tracking-pipeline",
    prompt:
      `查询国际订单（query 用 ${H_QUERY}），取前 ${H_LIMIT} 个。对每个订单，用订单号作为 order_no、目的国作为 country 获取物流跟踪。` +
      `只保留状态为 active 且预计到达天数不超过 ${H_MAX_ETA_DAYS} 天的订单，按预计到达天数从短到长取前 ${H_TAKE_COUNT} 个，返回订单号。`,
    tools: buildHTools(),
    spec: R7_H_SPEC,
    oracle: computeR7HGroundTruth(),
    pipelineToolIds: ["shipment.search_orders", "shipment.get_tracking"],
  };
}
