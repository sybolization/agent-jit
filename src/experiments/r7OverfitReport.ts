#!/usr/bin/env node

/**
 * R7 prompt overfit 报告（离线、只读）：
 * 对每个 R7 arm 实际会进入模型上下文的 prompt/tool-description 文本，
 * 对照 A/B/H 任务 prompt 与 oracle，输出泄漏 token、最长公共子串、
 * 共享字符二元组与共享词。结果写 overfit-audit.json，不参与决策阈值。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  describeProgramDescription,
  executeProgramDescription,
  renderRoutingDslReference,
} from "../prompt/routingToolPrompts.js";
import { R7_ARMS } from "./r7RoutingBenchmark.js";
import { r5ControlSystemPrompt, r5TreatmentSystemPrompt } from "./r5OffloadingBenchmark.js";
import { createR7HTask, r7DevelopmentTasks, type R7Task } from "./r7Tasks.js";
import { auditPromptOverlap } from "./r7OverfitAudit.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

export type ArmDef = (typeof R7_ARMS)[number];

export function armPromptTexts(arm: ArmDef): readonly string[] {
  if (arm.kind === "control") {
    return [r5ControlSystemPrompt()];
  }
  if (arm.kind === "positive") {
    return [r5TreatmentSystemPrompt({ contractMode: "eager-signatures", boundaryPolicy: false })];
  }
  const routingPrompt = arm.routingPrompt ?? "baseline";
  const texts = [
    r5ControlSystemPrompt(),
    executeProgramDescription(routingPrompt),
    describeProgramDescription(routingPrompt),
  ];
  if (arm.describeDslReference === "first-call") {
    texts.push(renderRoutingDslReference());
  }
  return texts;
}

export function r7AuditTasks(): readonly R7Task[] {
  return [...r7DevelopmentTasks(), createR7HTask()];
}

function main(): void {
  const taskList = r7AuditTasks();
  const rows = R7_ARMS.map((arm) => {
    const promptText = armPromptTexts(arm).join("\n");
    const audits = Object.fromEntries(
      taskList.map((task) => [
        task.id,
        auditPromptOverlap(promptText, [task.prompt, ...task.oracle.map(String)]),
      ]),
    );
    return { armId: arm.id, armLabel: arm.label, promptText, audits };
  });

  console.log("===== R7 prompt overfit audit =====");
  for (const row of rows) {
    const worst = Math.max(...taskList.map((task) => row.audits[task.id]!.longestCommonSubstringLength));
    const hits = new Set(taskList.flatMap((task) => row.audits[task.id]!.forbiddenTokenHits));
    console.log(
      `[${row.armId}] longestCommonSubstring=${worst} forbiddenHits=${[...hits].join(",") || "无"}`,
    );
  }

  const outPath = path.join(REPO_ROOT, "logs", "experiments", "r7-prompt-overfit-audit.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2)}\n`);
  console.log(`\n[audit] ${outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
