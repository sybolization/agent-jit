#!/usr/bin/env node

/**
 * R4d 结果绘图：读取 semantic-benchmark 目录下的 report.json，生成自包含 HTML（内联 SVG，无外部依赖）。
 *
 * 兼容 R4c（task.level）与 R4d（task.depth）两种 report 结构。
 * 用法：npx tsx src/experiments/plotReport.ts logs/experiments/semantic-benchmark-<ts>/report.json [--no-open]
 * 输出：与 report.json 同目录的 report-plot.html，并用系统浏览器打开。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// 读取与聚合
// ---------------------------------------------------------------------------

interface RunRecord {
  ok: boolean;
  round_trips: number;
  model_ingress_bytes: number;
  model_egress_bytes: number;
  runtime_internal_bytes: number;
  runtime_ms?: number;
  tool_ms?: number;
  e2e_ms: number;
  task_pass: boolean;
  maxed_out?: boolean;
  usage?: { totalTokens?: number };
  error?: string;
}

interface CellResult {
  arm: "dsl" | "iterative";
  depth?: string;
  level?: string;
  n: number;
  runs: RunRecord[];
}

interface Report {
  mode?: string;
  samples?: number;
  groundTruth?: Record<string, string[]>;
  kept?: Record<string, { kept: number; total: number }>;
  results: CellResult[];
}

function avg(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function depthOf(cell: CellResult): string {
  return cell.depth ?? cell.level ?? "?";
}

function labelOf(cell: CellResult): string {
  return `${depthOf(cell)}|${cell.n}`;
}

/** 每 cell 两臂聚合（tokens 在 DSL 侧一并算 runtime_internal / runtime_ms）。 */
interface CellAgg {
  label: string;
  depth: string;
  n: number;
  dslTokens: number;
  iterTokens: number;
  dslRuntimeBytes: number;
  dslExecMs: number;
  taskRate: { dsl: number; iterative: number };
}

function aggregate(report: Report): CellAgg[] {
  const byLabel = new Map<string, CellAgg>();
  for (const cell of report.results) {
    const label = labelOf(cell);
    let agg = byLabel.get(label);
    if (!agg) {
      agg = {
        label,
        depth: depthOf(cell),
        n: cell.n,
        dslTokens: 0,
        iterTokens: 0,
        dslRuntimeBytes: 0,
        dslExecMs: 0,
        taskRate: { dsl: 0, iterative: 0 },
      };
      byLabel.set(label, agg);
    }
    const runs = cell.runs;
    if (cell.arm === "dsl") {
      agg.dslTokens = avg(runs.map((run) => run.usage?.totalTokens ?? 0));
      agg.dslRuntimeBytes = avg(runs.map((run) => run.runtime_internal_bytes ?? 0));
      agg.dslExecMs = avg(runs.map((run) => run.runtime_ms ?? 0));
      agg.taskRate.dsl = Math.round((runs.filter((run) => run.task_pass).length / runs.length) * 100);
    } else {
      agg.iterTokens = avg(runs.map((run) => run.usage?.totalTokens ?? 0));
      agg.taskRate.iterative = Math.round((runs.filter((run) => run.task_pass).length / runs.length) * 100);
    }
  }
  const rank = (agg: CellAgg): number => {
    const depthIndex = agg.depth.startsWith("D") || agg.depth.startsWith("L") ? Number(agg.depth.slice(1)) : 0;
    return depthIndex * 100 + agg.n;
  };
  return [...byLabel.values()].sort((a, b) => rank(a) - rank(b));
}

/** 某指标的每 cell 两臂均值（arm 无关的 run 字段）。 */
function metricOf(
  report: Report,
  cells: CellAgg[],
  pick: (run: RunRecord) => number,
): Array<{ label: string; a: number; b: number }> {
  const map = new Map<string, { a: number[]; b: number[] }>();
  for (const cell of report.results) {
    const label = labelOf(cell);
    const entry = map.get(label) ?? { a: [], b: [] };
    (cell.arm === "dsl" ? entry.a : entry.b).push(...cell.runs.map(pick));
    map.set(label, entry);
  }
  return cells.map((cell) => ({
    label: cell.label,
    a: avg(map.get(cell.label)?.a ?? []),
    b: avg(map.get(cell.label)?.b ?? []),
  }));
}

/** 执行耗时按臂分别取（DSL=runtime_ms，iterative=tool_ms）。 */
function execMetric(report: Report, cells: CellAgg[]): Array<{ label: string; a: number; b: number }> {
  return cells.map((cell) => {
    const dsl = avg(
      report.results
        .filter((item) => item.arm === "dsl" && labelOf(item) === cell.label)
        .flatMap((item) => item.runs.map((run) => run.runtime_ms ?? 0)),
    );
    const iter = avg(
      report.results
        .filter((item) => item.arm === "iterative" && labelOf(item) === cell.label)
        .flatMap((item) => item.runs.map((run) => run.tool_ms ?? 0)),
    );
    return { label: cell.label, a: dsl, b: iter };
  });
}

/** 按深度折叠（D1/D2/D3 均值），看 depth scaling。 */
function byDepth(
  cells: CellAgg[],
  metric: Array<{ label: string; a: number; b: number }>,
): Array<{ label: string; a: number; b: number }> {
  const map = new Map<string, { a: number[]; b: number[] }>();
  for (const cell of cells) {
    const point = metric.find((item) => item.label === cell.label);
    if (!point) continue;
    const entry = map.get(cell.depth) ?? { a: [], b: [] };
    entry.a.push(point.a);
    entry.b.push(point.b);
    map.set(cell.depth, entry);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([depth, entry]) => ({ label: depth, a: avg(entry.a), b: avg(entry.b) }));
}

// ---------------------------------------------------------------------------
// SVG 渲染（纯字符串，无依赖）
// ---------------------------------------------------------------------------

const W = 940;
const H = 400;
const M = { top: 36, right: 30, bottom: 64, left: 84 };

const SERIES = [
  { name: "DSL", color: "#4C78A8" },
  { name: "Iterative", color: "#E45756" },
];

type Kind = "bytes" | "ms" | "num" | "percent" | "tokens";

function fmtValue(value: number, kind: Kind): string {
  if (kind === "bytes") return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(2)} MB` : `${(value / 1024).toFixed(1)} KB`;
  if (kind === "ms") return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
  if (kind === "percent") return `${Math.round(value)}%`;
  if (kind === "tokens") return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value));
  return String(Math.round(value));
}

function yTicks(max: number, count = 5): number[] {
  const step = max / count;
  return Array.from({ length: count + 1 }, (_, i) => i * step);
}

function axisAndGrid(max: number, kind: Kind): { svg: string; yAt: (value: number) => number } {
  const plotH = H - M.top - M.bottom;
  const yAt = (value: number) => M.top + plotH - (value / max) * plotH;
  let svg = "";
  for (const tick of yTicks(max)) {
    const y = yAt(tick);
    svg += `<line x1="${M.left}" y1="${y}" x2="${W - M.right}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>`;
    svg += `<text x="${M.left - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="#6b7280">${fmtValue(tick, kind)}</text>`;
  }
  return { svg, yAt };
}

/** 分组条形图：每组两根（DSL / Iterative）。 */
function barChart(title: string, subtitle: string, data: Array<{ label: string; a: number; b: number }>, kind: Kind): string {
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const max = Math.max(...data.flatMap((item) => [item.a, item.b]), 1) * 1.15;
  const groupW = plotW / data.length;
  const barW = Math.min(groupW * 0.32, 46);
  const groupStart = (index: number) => M.left + index * groupW + (groupW - barW * 2 - 12) / 2;
  const { svg: grid, yAt } = axisAndGrid(max, kind);

  let body = "";
  data.forEach((item, index) => {
    const x = groupStart(index);
    const bar = (value: number, color: string, offset: number) => {
      const h = (value / max) * plotH;
      const y = yAt(value);
      return `<rect x="${x + offset}" y="${y}" width="${barW}" height="${Math.max(h, 0.5)}" fill="${color}" rx="2"/>
<text x="${x + offset + barW / 2}" y="${y - 5}" text-anchor="middle" font-size="10" fill="#374151">${fmtValue(value, kind)}</text>`;
    };
    body += bar(item.a, SERIES[0]!.color, 0);
    body += bar(item.b, SERIES[1]!.color, barW + 12);
    body += `<text x="${x + barW + 6}" y="${M.top + plotH + 20}" text-anchor="middle" font-size="12" fill="#111827">${item.label}</text>`;
  });
  const yLabel = kind === "percent" ? "task pass %" : kind === "tokens" ? "tokens" : kind === "bytes" ? "bytes" : kind === "ms" ? "时间 (ms)" : "次数";
  const svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="system-ui, sans-serif">
<title>${title}</title>
${grid}
${body}
<text x="16" y="${M.top + plotH / 2}" transform="rotate(-90 16 ${M.top + plotH / 2})" text-anchor="middle" font-size="11" fill="#6b7280">${yLabel}</text>
</svg>`;
  return chartCard(title, subtitle, svg);
}

/** 折线图：两序列。 */
function lineChart(title: string, subtitle: string, data: Array<{ label: string; a: number; b: number }>, kind: Kind): string {
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const max = Math.max(...data.flatMap((item) => [item.a, item.b]), 1) * 1.12;
  const xAt = (index: number) => M.left + (data.length === 1 ? plotW / 2 : (index / (data.length - 1)) * plotW);
  const { svg: grid, yAt } = axisAndGrid(max, kind);

  let body = "";
  for (const seriesIndex of [0, 1] as const) {
    const key = seriesIndex === 0 ? "a" : "b";
    const color = SERIES[seriesIndex]!.color;
    const points = data.map((item, index) => `${xAt(index)},${yAt(item[key])}`);
    if (points.length > 1) body += `<polyline points="${points.join(" ")}" fill="none" stroke="${color}" stroke-width="2.5"/>`;
    data.forEach((item, index) => {
      const cx = xAt(index);
      const cy = yAt(item[key]);
      body += `<circle cx="${cx}" cy="${cy}" r="4" fill="${color}"/>`;
      body += `<text x="${cx}" y="${cy - 8}" text-anchor="middle" font-size="9.5" fill="#374151">${fmtValue(item[key], kind)}</text>`;
    });
  }
  data.forEach((item, index) => {
    body += `<text x="${xAt(index)}" y="${M.top + plotH + 20}" text-anchor="middle" font-size="12" fill="#111827">${item.label}</text>`;
  });
  SERIES.forEach((item, index) => {
    const lx = M.left + index * 110;
    body += `<rect x="${lx}" y="${M.top - 26}" width="12" height="12" rx="2" fill="${item.color}"/>
<text x="${lx + 17}" y="${M.top - 16}" font-size="11" fill="#111827">${item.name}</text>`;
  });
  const svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="system-ui, sans-serif">
<title>${title}</title>
${grid}
${body}
</svg>`;
  return chartCard(title, subtitle, svg);
}

function chartCard(title: string, subtitle: string, svg: string): string {
  return `<div class="card"><h3>${title}</h3><p class="sub">${subtitle}</p>${svg}</div>`;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function main(argv: string[]): number {
  const reportArg = argv.find((item) => !item.startsWith("--"));
  const openBrowser = !argv.includes("--no-open");
  if (!reportArg) {
    console.error("用法：npx tsx src/experiments/plotReport.ts <report.json 路径> [--no-open]");
    return 1;
  }
  const reportPath = path.resolve(reportArg);
  if (!fs.existsSync(reportPath)) {
    console.error(`[FAIL] 找不到报告：${reportPath}`);
    return 1;
  }
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as Report;
  const cells = aggregate(report);

  const tokens = cells.map((cell) => ({ label: cell.label, a: cell.dslTokens, b: cell.iterTokens }));
  const ingress = metricOf(report, cells, (run) => run.model_ingress_bytes);
  const egress = metricOf(report, cells, (run) => run.model_egress_bytes);
  const rounds = metricOf(report, cells, (run) => run.round_trips);
  const exec = execMetric(report, cells);
  const taskRates = cells.map((cell) => ({ label: cell.label, a: cell.taskRate.dsl, b: cell.taskRate.iterative }));
  const depthIngress = byDepth(cells, ingress);
  const depthTokens = byDepth(cells, tokens);

  const gtRows = Object.entries(report.groundTruth ?? {})
    .map(([key, names]) => `<tr><td><b>${key}</b></td><td>${names.join(", ")}</td></tr>`)
    .join("");
  const keptRows = Object.entries(report.kept ?? {})
    .map(([key, value]) => `<tr><td><b>${key}</b></td><td>${value.kept} / ${value.total}（淘汰 ${value.total - value.kept}）</td></tr>`)
    .join("");

  const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8"/>
<title>${report.mode ?? "semantic-benchmark"} 结果可视化</title>
<style>
:root { --dsl:#4C78A8; --iter:#E45756; }
body { font-family: system-ui, -apple-system, "PingFang SC", sans-serif; margin: 24px auto; max-width: 1020px; color: #111827; background: #fafafa; }
h1 { font-size: 20px; } h2 { font-size: 16px; margin: 30px 0 8px; border-bottom: 2px solid #e5e7eb; padding-bottom: 6px; }
h3 { font-size: 14px; margin: 0 0 4px; } .sub { color: #6b7280; font-size: 12px; margin: 0 0 8px; }
.card { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; margin: 14px 0; }
.card svg { width: 100%; height: auto; }
table { border-collapse: collapse; width: 100%; font-size: 12px; margin-top: 8px; }
th, td { border: 1px solid #e5e7eb; padding: 5px 8px; text-align: right; }
th { background: #f3f4f6; } td:first-child, th:first-child { text-align: left; }
.meta { color: #6b7280; font-size: 12px; }
.legend span { margin-right: 16px; font-size: 12px; }
.dot { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:4px; }
</style>
</head>
<body>
<h1>${report.mode ?? "semantic-benchmark"} — 结果可视化</h1>
<p class="meta">报告：${reportPath} ｜ 样本：${report.samples ?? "?"} / cell ｜ samples × 2 臂 × ${cells.length} cells</p>

<h2>Ground Truth 与数据集校验</h2>
<div class="card"><h3>ground truth（每 cell 一次快照，两臂共用）</h3><table><thead><tr><th>cell</th><th>答案（owner/repo）</th></tr></thead><tbody>${gtRows}</tbody></table></div>
<div class="card"><h3>filter 淘汰统计（kept / total）</h3><table><thead><tr><th>cell</th><th>保留 / 总数（淘汰数）</th></tr></thead><tbody>${keptRows}</tbody></table></div>

<h2>正确率</h2>
${barChart("Task Pass 率（严格答案匹配 + 图语义）", "iterative 必须调用 submit_answer 才计为已提交；DSL = 答案精确匹配 AND 计算图语义正确", taskRates, "percent")}

<h2>成本随深度缩放</h2>
<div class="legend"><span><span class="dot" style="background:var(--dsl)"></span>DSL</span><span><span class="dot" style="background:var(--iter)"></span>Iterative</span></div>
${lineChart("模型 tokens（均值 / cell）", "DSL 只写一次程序；iterative 每轮把完整历史重新送模型", tokens, "tokens")}
${lineChart("模型输入字节 model_ingress（均值 / cell）", "中间工具结果是否重新进入模型 context 的度量", ingress, "bytes")}
${lineChart("模型输出字节 model_egress（均值 / cell）", "", egress, "bytes")}
${barChart("LLM round trips（均值 / cell）", "深度 D1→D3：iterative 的决策轮数随依赖层增长，DSL 恒 1", rounds, "num")}
${lineChart("深度折叠：tokens（D1/D2/D3 平均）", "depth scaling：iterative 随深度暴涨，DSL 基本恒定", depthTokens, "tokens")}
${lineChart("深度折叠：model_ingress（D1/D2/D3 平均）", "depth scaling：中间数据进不进 model context", depthIngress, "bytes")}

<h2>数据“去了哪里”</h2>
${barChart("DSL runtime_internal_bytes（留在 runtime 的中间数据）", "DSL 臂独有；iterative 恒 0（中间数据 100% 经过模型）", cells.map((cell) => ({ label: cell.label, a: cell.dslRuntimeBytes, b: 0 })), "bytes")}
${barChart("执行耗时 execMs（均值 / cell）", "DSL=runtime_ms，iterative=tool_ms（同并发上限 5）", exec, "ms")}

<h2>汇总表</h2>
<div class="card"><table>
<thead><tr><th>cell</th><th>DSL task%</th><th>Iter task%</th><th>DSL roundTrips</th><th>Iter roundTrips</th><th>DSL ingress</th><th>Iter ingress</th><th>DSL tokens</th><th>Iter tokens</th><th>DSL runtimeB</th><th>DSL execMs</th><th>Iter execMs</th></tr></thead>
<tbody>
${cells.map((cell) => {
  const ingressCell = ingress.find((item) => item.label === cell.label)!;
  const roundsCell = rounds.find((item) => item.label === cell.label)!;
  const execCell = exec.find((item) => item.label === cell.label)!;
  return `<tr><td><b>${cell.label}</b></td>
<td>${cell.taskRate.dsl}%</td><td>${cell.taskRate.iterative}%</td>
<td>${roundsCell.a.toFixed(1)}</td><td>${roundsCell.b.toFixed(1)}</td>
<td>${fmtValue(ingressCell.a, "bytes")}</td><td>${fmtValue(ingressCell.b, "bytes")}</td>
<td>${fmtValue(cell.dslTokens, "tokens")}</td><td>${fmtValue(cell.iterTokens, "tokens")}</td>
<td>${fmtValue(cell.dslRuntimeBytes, "bytes")}</td>
<td>${fmtValue(execCell.a, "ms")}</td><td>${fmtValue(execCell.b, "ms")}</td></tr>`;
}).join("")}
</tbody></table></div>
</body></html>`;

  const outPath = path.join(path.dirname(reportPath), "report-plot.html");
  fs.writeFileSync(outPath, html, "utf8");
  console.log(`已生成: ${outPath}`);
  if (openBrowser) {
    const result = spawnSync("open", [outPath], { stdio: "ignore" });
    if (result.status !== 0) console.log("（自动打开浏览器失败，可手动打开上面的文件）");
  }
  return 0;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
