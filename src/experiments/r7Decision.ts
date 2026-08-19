/**
 * R7 development 预注册决策规则（纯函数）。
 *
 * 目的：在正式结果出来**之前**把选择规则固化成代码，避免看到数据后
 * 临时调整阈值 / 挑臂（prompt overfit 的决策层变体）。
 *
 * 规则来源：docs/r7-routing-plan.md 第 6 节，2026-08-17 冻结。
 * - development 只用 B 任务选择胜出臂；
 * - 门槛：taskCompletionRate >= 0.9 且 offloadPrecision >= 0.9；
 * - 在候选 T0–T4 中选 efficiencyScore 最低者；
 * - 若与最优效率差距 < 5%，优先选工具面常驻描述更短的臂；
 * - T0–T4 无人过门槛 → 结论 "system-prompt-required"，不进入 holdout；
 * - C0 / P0 只作参照，不作为候选胜出臂。
 */

import type { R7ArmId } from "./r7RoutingBenchmark.js";

export const R7_DEVELOPMENT_RULES = {
  minTaskCompletionRate: 0.9,
  minOffloadPrecision: 0.9,
  efficiencyTieTolerance: 0.05,
  candidateArmIds: ["T0", "T1", "T2", "T3", "T4"] as const,
} as const;

/**
 * Holdout 判定规则（2026-08-17 冻结，H 数据出来前定义）：
 * - development winner 在 H 上必须再次达到 0.9 / 0.9 门槛；
 * - efficiencyScore 必须严格不劣于 P0（<= P0，不给 tolerance——
 *   因为 development 已经承担了探索性选择）；
 * - 跨模型抽检 precision 必须 >= 0.9。
 */
export const R7_HOLDOUT_RULES = {
  minTaskCompletionRate: 0.9,
  minOffloadPrecision: 0.9,
  minCrossModelPrecision: 0.9,
} as const;

/** 工具面常驻描述字符数（execute + describe；T2 的 manual 是按需加载，不计入常驻）。 */
export const R7_CONSTANT_DESCRIPTION_CHARS: Record<(typeof R7_DEVELOPMENT_RULES.candidateArmIds)[number], number> = {
  T0: 64 + 107,
  T1: 210 + 163,
  T2: 210 + 163,
  T3: 1771 + 107,
  T4: 598 + 107,
};

export interface R7CellSummary {
  armId: R7ArmId;
  taskId: "A" | "B" | "H";
  runs: number;
  taskCompletionRate: number;
  offloadPrecision: number;
  efficiencyScore: number;
  unnecessaryOffloadRate: number;
  avgTokens: number;
  /** 以下为过程观测（可选，不参与预注册决策）。 */
  cleanOffloadRate?: number;
  fallbackRate?: number;
  maxedOutRate?: number;
  avgRepairRounds?: number;
  avgRounds?: number;
}

export interface R7DevelopmentDecision {
  rules: typeof R7_DEVELOPMENT_RULES;
  /** 只包含候选 T0–T4 的 B 格摘要（按 efficiencyScore 升序）。 */
  candidateCells: readonly R7CellSummary[];
  eligibleArmIds: readonly R7ArmId[];
  /** 候选全部不满足门槛 → system-prompt-required；否则 holdout-pending。 */
  conclusion: "holdout-pending" | "system-prompt-required";
  /** 预注册规则选出的 development winner（无 winner 时为 undefined）。 */
  winnerArmId?: R7ArmId;
  /** 参照值：P0 的 B 格 efficiencyScore（缺失为 +∞）。 */
  positiveControlEfficiency: number;
}

function isCandidateArm(id: R7ArmId): id is (typeof R7_DEVELOPMENT_RULES.candidateArmIds)[number] {
  return (R7_DEVELOPMENT_RULES.candidateArmIds as readonly string[]).includes(id);
}

/** 预注册决策函数：只吃 B 任务 cell，返回 winner 与 conclusion。 */
export function decideR7Development(cells: readonly R7CellSummary[]): R7DevelopmentDecision {
  const bCells = cells.filter((cell) => cell.taskId === "B");
  const candidateCells = bCells
    .filter((cell): cell is R7CellSummary & { armId: (typeof R7_DEVELOPMENT_RULES.candidateArmIds)[number] } =>
      isCandidateArm(cell.armId),
    )
    .sort((a, b) => a.efficiencyScore - b.efficiencyScore);

  const eligible = candidateCells.filter(
    (cell) =>
      cell.taskCompletionRate >= R7_DEVELOPMENT_RULES.minTaskCompletionRate &&
      cell.offloadPrecision >= R7_DEVELOPMENT_RULES.minOffloadPrecision,
  );

  const p0 = bCells.find((cell) => cell.armId === "P0");
  let winnerArmId: R7ArmId | undefined;
  if (eligible.length > 0) {
    const bestEfficiency = eligible[0]!.efficiencyScore;
    const tied = eligible.filter(
      (cell) => cell.efficiencyScore <= bestEfficiency * (1 + R7_DEVELOPMENT_RULES.efficiencyTieTolerance),
    );
    const winner = tied.sort(
      (a, b) => R7_CONSTANT_DESCRIPTION_CHARS[a.armId] - R7_CONSTANT_DESCRIPTION_CHARS[b.armId],
    )[0];
    winnerArmId = winner?.armId;
  }

  return {
    rules: R7_DEVELOPMENT_RULES,
    candidateCells,
    eligibleArmIds: eligible.map((cell) => cell.armId),
    conclusion: winnerArmId === undefined ? "system-prompt-required" : "holdout-pending",
    winnerArmId,
    positiveControlEfficiency: p0?.efficiencyScore ?? Number.POSITIVE_INFINITY,
  };
}

export type R7HoldoutConclusion = "recommend-default" | "reject" | "data-incomplete";

export interface R7HoldoutDecision {
  rules: typeof R7_HOLDOUT_RULES;
  winnerArmId: R7ArmId;
  winnerCell?: R7CellSummary;
  positiveControlCell?: R7CellSummary;
  gatePass: boolean;
  efficiencyNotWorseThanP0: boolean;
  conclusion: R7HoldoutConclusion;
  reasons: readonly string[];
}

/**
 * 预注册 holdout 判定：只吃 H 任务 cells 和 development winner。
 * 该函数在 H 跑批前冻结，H 结果出来后不得修改判定口径。
 */
export function decideR7Holdout(cells: readonly R7CellSummary[], winnerArmId: R7ArmId): R7HoldoutDecision {
  const hCells = cells.filter((cell) => cell.taskId === "H");
  const winnerCell = hCells.find((cell) => cell.armId === winnerArmId);
  const positiveControlCell = hCells.find((cell) => cell.armId === "P0");
  const reasons: string[] = [];

  if (winnerCell === undefined || positiveControlCell === undefined) {
    reasons.push("H 任务缺少 winner 或 P0 的完整 cell");
    return {
      rules: R7_HOLDOUT_RULES,
      winnerArmId,
      gatePass: false,
      efficiencyNotWorseThanP0: false,
      conclusion: "data-incomplete",
      reasons,
    };
  }

  const gatePass =
    winnerCell.taskCompletionRate >= R7_HOLDOUT_RULES.minTaskCompletionRate &&
    winnerCell.offloadPrecision >= R7_HOLDOUT_RULES.minOffloadPrecision;
  if (!gatePass) {
    reasons.push(
      `winner 未过 holdout 门槛（completion=${winnerCell.taskCompletionRate}, precision=${winnerCell.offloadPrecision}）`,
    );
  }

  const efficiencyNotWorseThanP0 = winnerCell.efficiencyScore <= positiveControlCell.efficiencyScore;
  if (!efficiencyNotWorseThanP0) {
    reasons.push(
      `winner efficiency ${winnerCell.efficiencyScore} 劣于 P0 ${positiveControlCell.efficiencyScore}`,
    );
  }

  return {
    rules: R7_HOLDOUT_RULES,
    winnerArmId,
    winnerCell,
    positiveControlCell,
    gatePass,
    efficiencyNotWorseThanP0,
    conclusion: gatePass && efficiencyNotWorseThanP0 ? "recommend-default" : "reject",
    reasons,
  };
}

/** 跨模型抽检：只判断 precision 是否达到预注册门槛。 */
export function evaluateR7CrossModelPrecision(offloadPrecision: number): "pass" | "blocked" {
  return offloadPrecision >= R7_HOLDOUT_RULES.minCrossModelPrecision ? "pass" : "blocked";
}
