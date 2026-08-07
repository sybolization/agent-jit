#!/usr/bin/env node

/**
 * DSL arm of the "Canvas DSL vs JSON" experiment — tool-call variant.
 *
 * The JSON arm is the existing real-LLM harness at
 * `test/agent-harness-test/harness_batch.py` (semantic_v1 agent through the
 * Workbench API). This script is the DSL arm: instead of asking the model to
 * reply with DSL as free text, the DSL is submitted through a real tool call
 * (`apply_canvas_dsl`) inside the same pi-agent tool loop the product agent
 * uses. The tool compiles with the real compiler (`compileCanvasDsl`) and
 * returns diagnostics as a structured tool error, which the agent fixes in the
 * next call.
 *
 * Env: LLM_GATEWAY_URL / LLM_GATEWAY_MODEL / LLM_GATEWAY_TOKEN (loaded from
 * the repository root `.env` if not already present).
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

import { defaultRuntime } from "../agent/promptBuilder.js";
import type { CanvasWorkflowTool } from "../contracts/canvas.js";
import type { SemanticCanvasGraphV1 } from "../contracts/semanticCanvas.js";
import type { SubgraphTransactionV1 } from "../contracts/subgraphTransaction.js";
import { CanvasDslCompileError, type CanvasDslDiagnostic, compileCanvasDsl } from "../domain/canvas/canvasDsl.js";
import { renderWorkflowDslCatalog } from "../domain/canvas/canvasDslCatalog.js";
import { CANVAS_DSL_GRAMMAR_PROMPT } from "../domain/canvas/canvasDslGrammar.js";
import { SemanticCanvasHarness } from "../domain/canvas/semanticTransaction.js";
import { ToolValidationError } from "../domain/canvas/toolErrors.js";
import { toolResult } from "../tools/canvas/runtime.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const AGENT_RUNNER_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const REPO_ROOT = path.resolve(AGENT_RUNNER_ROOT, "..");
const DEFAULT_BASE_URL = "http://127.0.0.1:8088";
const DEFAULT_PROMPT =
  "请构建一个包含 15 个节点的画布工作流，节点之间用输入引用连接，形成一个完整的创作链路。展示你的规划能力。";
const INTERNAL_PARAMETER_KEYS = new Set(["filename_prefix", "output_prefix"]);
const OUTPUT_KIND_BY_FILE_KIND: Record<string, string | undefined> = {
  image: "image",
  video: "video",
  audio: "audio",
};
const MAX_TOOL_ITERATIONS = 30;

const ApplyCanvasDslSchema = Type.Object({
  dsl: Type.String({ minLength: 1, maxLength: 50_000 }),
});

type Args = {
  baseUrl: string;
  rounds: number;
  prompt: string;
  timeoutSeconds: number;
  reportDir: string;
  conformance: boolean;
};

type AttemptEvidence = {
  attempt: number;
  llm_duration_ms: number;
  compile_duration_ms: number;
  dsl: string;
  hard_errors: Array<{ line: number; code: string; message: string }>;
  soft_incomplete: string[];
  node_count: number;
};

type ToolCallRecord = {
  calledAt: number;
  dsl: string;
  compile_ms: number;
  hard_errors: Array<{ line: number; code: string; message: string }>;
  soft_incomplete: string[];
  node_count: number;
};

type RoundUsage = {
  llm_calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  totalTokens: number;
};

type RoundEvidence = {
  round: number;
  started_at: string;
  completed_at: string;
  duration_seconds: number;
  prompt: string;
  attempts: AttemptEvidence[];
  tool_calls: number;
  first_pass: boolean;
  success: boolean;
  node_count: number;
  incomplete_nodes: number;
  hard_error_codes: string[];
  final_dsl: string;
  conformance?: {
    accepted: boolean;
    error_code?: string;
    error_message?: string;
    harness_nodes?: number;
    compiler_nodes?: number;
  };
  usage?: RoundUsage;
  collector_error?: string;
  evidence_file?: string;
};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function loadRootEnv(): void {
  const envPath = path.join(REPO_ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function parseArgs(argv: string[]): Args {
  const read = (name: string, fallback: string): string => {
    const index = argv.indexOf(name);
    const value = index >= 0 ? argv[index + 1] : undefined;
    return value ? value : fallback;
  };
  const rounds = Number(read("--rounds", "3"));
  const timeoutSeconds = Number(read("--timeout", "600"));
  return {
    baseUrl: read("--base-url", DEFAULT_BASE_URL).replace(/\/+$/, ""),
    rounds: Number.isSafeInteger(rounds) && rounds > 0 ? rounds : 3,
    prompt: read("--prompt", DEFAULT_PROMPT),
    timeoutSeconds: Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 600,
    reportDir: read("--report-dir", ""),
    conformance: argv.includes("--conformance"),
  };
}

function defaultReportDir(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(REPO_ROOT, "logs", "agent", "dsl-harness-tool", stamp);
}

// ---------------------------------------------------------------------------
// Workbench auth + workflow catalog (mirrors harness_batch.py)
// ---------------------------------------------------------------------------

async function registerUser(baseUrl: string): Promise<{ token: string; csrf: string }> {
  const csrfResponse = await fetch(`${baseUrl}/api/auth/csrf`);
  if (!csrfResponse.ok) throw new Error(`csrf failed: ${csrfResponse.status}`);
  const setCookie = csrfResponse.headers.get("set-cookie") || "";
  const csrfPayload = (await csrfResponse.json()) as { csrf_token?: string };
  const csrf = String(csrfPayload.csrf_token || "");
  const suffix = Math.random().toString(16).slice(2, 12);
  const password = "DslHarness123!";
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf,
      ...(setCookie ? { Cookie: setCookie } : {}),
    },
    body: JSON.stringify({
      username: `dsl-harness-${suffix}`,
      password,
      password_confirmation: password,
      display_name: `DSL Harness ${suffix}`,
    }),
  });
  if (!response.ok) throw new Error(`register failed: ${response.status} ${await response.text()}`);
  const payload = (await response.json()) as { access_token?: string };
  return { token: String(payload.access_token || ""), csrf };
}

async function fetchWorkflowTools(baseUrl: string, token: string): Promise<CanvasWorkflowTool[]> {
  const headers = { Authorization: `Bearer ${token}` };
  const listResponse = await fetch(`${baseUrl}/api/workflow-catalog`, { headers });
  if (!listResponse.ok) throw new Error(`workflow-catalog failed: ${listResponse.status}`);
  const summaries = (await listResponse.json()) as Array<Record<string, unknown>>;

  const tools: CanvasWorkflowTool[] = [];
  for (const summary of summaries) {
    if (summary.agent_enabled !== true || typeof summary.id !== "string") continue;
    const specResponse = await fetch(`${baseUrl}/api/workflow-catalog/${summary.id}/spec`, { headers });
    if (!specResponse.ok) continue;
    const spec = (await specResponse.json()) as Record<string, unknown>;
    const output = (spec.output ?? {}) as Record<string, unknown>;
    const outputKind = OUTPUT_KIND_BY_FILE_KIND[String(output.file_kind ?? "")];
    const rawParameters = ((spec.parameters ?? []) as Array<Record<string, unknown>>).filter(
      (parameter) => typeof parameter.key === "string" && !INTERNAL_PARAMETER_KEYS.has(parameter.key as string),
    );
    const parametersByKey = new Map(rawParameters.map((parameter) => [String(parameter.key), parameter]));
    tools.push({
      id: spec.id as string,
      label: (spec.display_name as string | undefined) ?? (spec.id as string),
      ...(typeof spec.description === "string" ? { description: spec.description } : {}),
      ...(outputKind !== undefined ? { outputKind } : {}),
      // The spec's references carry no `required` flag (it lives on the
      // matching parameter), so derive it from the parameter like
      // canvas_agent_tooling does — otherwise every reference would be
      // treated as mandatory and optional multi-inputs (video_2..6) would be
      // wrongly flagged as missing.
      references: ((spec.references ?? []) as Array<Record<string, unknown>>)
        .filter(
          (reference) =>
            typeof reference.parameter_key === "string" && ["image", "audio", "video"].includes(String(reference.kind)),
        )
        .map((reference) => ({
          parameterKey: reference.parameter_key as string,
          kind: reference.kind as string,
          required: parametersByKey.get(reference.parameter_key as string)?.required === true,
          label: (reference.label as string | undefined) ?? (reference.parameter_key as string),
        })),
      // Null defaults (Python None) are not real defaults; the backend agent
      // payload excludes them (exclude_none). Mirror that so required-flag and
      // hasDefault semantics match the product.
      parameters: rawParameters.map((parameter) => ({
        key: parameter.key as string,
        label: (parameter.label as string | undefined) ?? (parameter.key as string),
        ...(typeof parameter.kind === "string" ? { kind: parameter.kind } : {}),
        required: parameter.required === true,
        ...(parameter.default !== null && parameter.default !== undefined ? { default: parameter.default } : {}),
        ...(Array.isArray(parameter.options) && parameter.options.length > 0 ? { options: parameter.options } : {}),
      })),
      defaults: {},
    });
  }
  if (tools.length === 0) throw new Error("workflow catalog is empty");
  return tools;
}

// ---------------------------------------------------------------------------
// Compile + evaluate
// ---------------------------------------------------------------------------

function diagnosticSummary(diagnostics: readonly CanvasDslDiagnostic[]): Array<{
  line: number;
  code: string;
  message: string;
}> {
  return diagnostics.map((item) => ({ line: item.line, code: item.code, message: item.message }));
}

function formatDiagnostics(diagnostics: readonly CanvasDslDiagnostic[]): string {
  return diagnostics.map((item) => `L${item.line}: ${item.code}: ${item.message}`).join("\n");
}

function evaluateDsl(
  text: string,
  tools: readonly CanvasWorkflowTool[],
): {
  hardErrors: boolean;
  hardDiagnostics: readonly CanvasDslDiagnostic[];
  softIncomplete: string[];
  nodeCount: number;
} {
  try {
    const result = compileCanvasDsl(text, { workflowTools: tools });
    const incomplete = result.graph.nodes
      .filter((node) => node.readiness.status === "incomplete")
      .flatMap((node) => node.readiness.missing_inputs.map((key) => `${node.id}:${key}`));
    return {
      hardErrors: false,
      hardDiagnostics: [],
      softIncomplete: incomplete,
      nodeCount: result.graph.nodes.length,
    };
  } catch (error) {
    if (error instanceof CanvasDslCompileError) {
      return {
        hardErrors: true,
        hardDiagnostics: error.diagnostics,
        softIncomplete: [],
        nodeCount: 0,
      };
    }
    throw error;
  }
}

// pi-agent-core attaches per-call usage (input/output/cacheRead/cacheWrite/
// reasoning/totalTokens) to every assistant message. Aggregate them so the
// experiment can attribute the DSL-vs-JSON gap to token volume vs retries.
function aggregateUsage(messages: readonly AgentMessage[]): RoundUsage | undefined {
  let llmCalls = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let reasoning = 0;
  let totalTokens = 0;
  for (const message of messages) {
    if (message.role !== "assistant" || !message.usage) continue;
    const usage = message.usage;
    if (
      (usage.input ?? 0) === 0 &&
      (usage.output ?? 0) === 0 &&
      (usage.cacheRead ?? 0) === 0 &&
      (usage.cacheWrite ?? 0) === 0
    ) {
      continue;
    }
    llmCalls += 1;
    input += usage.input ?? 0;
    output += usage.output ?? 0;
    cacheRead += usage.cacheRead ?? 0;
    cacheWrite += usage.cacheWrite ?? 0;
    reasoning += usage.reasoning ?? 0;
    totalTokens += usage.totalTokens ?? 0;
  }
  if (llmCalls === 0) return undefined;
  return { llm_calls: llmCalls, input, output, cacheRead, cacheWrite, reasoning, totalTokens };
}

// ---------------------------------------------------------------------------
// Agent tool loop
// ---------------------------------------------------------------------------

function buildApplyCanvasDslTool(
  tools: readonly CanvasWorkflowTool[],
  calls: ToolCallRecord[],
): AgentTool<typeof ApplyCanvasDslSchema, { ok: boolean; nodes?: number }> {
  return {
    name: "apply_canvas_dsl",
    label: "Compile and apply Canvas DSL",
    description:
      "编译并提交一段 Canvas DSL 工作流。返回节点数；编译错误或缺少必需输入时返回诊断，请修正后重新调用本工具。",
    parameters: ApplyCanvasDslSchema,
    executionMode: "sequential",
    execute: async (_toolCallId: string, args) => {
      const compileStarted = performance.now();
      const verdict = evaluateDsl(args.dsl, tools);
      calls.push({
        calledAt: performance.now(),
        dsl: args.dsl,
        compile_ms: Math.round(performance.now() - compileStarted),
        hard_errors: diagnosticSummary(verdict.hardDiagnostics),
        soft_incomplete: verdict.softIncomplete,
        node_count: verdict.nodeCount,
      });
      if (verdict.hardErrors) {
        throw new ToolValidationError(
          "dsl_compile_failed",
          `DSL 编译失败：\n${formatDiagnostics(verdict.hardDiagnostics)}`,
          { diagnostics: diagnosticSummary(verdict.hardDiagnostics) },
        );
      }
      if (verdict.softIncomplete.length > 0) {
        throw new ToolValidationError(
          "dsl_incomplete",
          `DSL 编译通过但有 ${verdict.softIncomplete.length} 个输入缺失：${verdict.softIncomplete.join(", ")}。请补齐后重新调用。`,
          { missing_inputs: verdict.softIncomplete },
        );
      }
      return toolResult(`编译成功：${verdict.nodeCount} 个节点，所有输入完整。`, {
        ok: true,
        nodes: verdict.nodeCount,
      });
    },
  };
}

function lastAssistantHasToolCall(messages: readonly AgentMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role === "user") return false;
    if (message.role === "assistant") {
      return Array.isArray(message.content) && message.content.some((block) => block.type === "toolCall");
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Conformance: push the compiled graph through the real harness pipeline
// (SemanticCanvasHarness.apply — the same validation the JSON path's
// apply_subgraph_transaction runs) by reconstructing an add-transaction from
// the compiled nodes and applying it to an empty canvas.
// ---------------------------------------------------------------------------

function conformGraph(
  graph: SemanticCanvasGraphV1,
  workflowTools: readonly CanvasWorkflowTool[],
): NonNullable<RoundEvidence["conformance"]> {
  const harness = new SemanticCanvasHarness({ workflowTools });
  const writeNodes = graph.nodes.map((node) => node.id).sort();
  const transaction: SubgraphTransactionV1 = {
    schema_version: "1",
    request_key: `dsl-conform-${randomUUID()}`,
    base_canvas_version: null,
    scope: {
      read_nodes: [],
      write_nodes: writeNodes,
      external_inputs: [],
      downstream_consumers: [],
    },
    operations: graph.nodes.map((node) => ({
      op: "add" as const,
      node: {
        id: node.id,
        kind: node.kind,
        title: node.title,
        inputs: node.inputs,
        config: node.config,
        ...(node.workflow_id !== undefined ? { workflow_id: node.workflow_id } : {}),
      },
    })),
  };
  const emptyGraph: SemanticCanvasGraphV1 = { schema_version: "1", canvas_version: null, nodes: [] };
  const result = harness.apply(emptyGraph, transaction);
  if (result.ok) {
    return { accepted: true, harness_nodes: result.graph.nodes.length, compiler_nodes: graph.nodes.length };
  }
  return {
    accepted: false,
    error_code: result.error.code,
    error_message: result.error.message,
    compiler_nodes: graph.nodes.length,
  };
}

// ---------------------------------------------------------------------------
// Round + report
// ---------------------------------------------------------------------------

async function runRound(
  systemPrompt: string,
  hardPrompt: string,
  tools: readonly CanvasWorkflowTool[],
  roundIndex: number,
  conformance: boolean,
): Promise<RoundEvidence> {
  const started = performance.now();
  const item: RoundEvidence = {
    round: roundIndex,
    started_at: new Date().toISOString(),
    completed_at: "",
    duration_seconds: 0,
    prompt: hardPrompt,
    attempts: [],
    tool_calls: 0,
    first_pass: false,
    success: false,
    node_count: 0,
    incomplete_nodes: 0,
    hard_error_codes: [],
    final_dsl: "",
  };
  try {
    const { model, streamFn } = defaultRuntime();
    const calls: ToolCallRecord[] = [];
    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        messages: [],
        tools: [buildApplyCanvasDslTool(tools, calls)],
      },
      convertToLlm: (messages) =>
        messages.filter(
          (message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
        ),
      streamFn,
      toolExecution: "sequential",
    });

    await agent.prompt({ role: "user", content: hardPrompt, timestamp: Date.now() });
    await agent.waitForIdle();
    let guard = 0;
    while (lastAssistantHasToolCall(agent.state.messages) && guard < MAX_TOOL_ITERATIONS) {
      await agent.continue();
      await agent.waitForIdle();
      guard += 1;
    }

    item.tool_calls = calls.length;
    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index] as ToolCallRecord;
      item.attempts.push({
        attempt: index + 1,
        llm_duration_ms: Math.round(
          call.calledAt - (index === 0 ? started : (calls[index - 1] as ToolCallRecord).calledAt),
        ),
        compile_duration_ms: call.compile_ms,
        dsl: call.dsl,
        hard_errors: call.hard_errors,
        soft_incomplete: call.soft_incomplete,
        node_count: call.node_count,
      });
    }

    const cleanCall = [...calls]
      .reverse()
      .find((call) => call.hard_errors.length === 0 && call.soft_incomplete.length === 0);
    const lastCall = calls.length > 0 ? calls[calls.length - 1] : undefined;
    item.success = Boolean(cleanCall);
    item.first_pass = calls.length > 0 && calls[0]?.hard_errors.length === 0 && calls[0]?.soft_incomplete.length === 0;
    item.node_count = cleanCall?.node_count ?? lastCall?.node_count ?? 0;
    item.incomplete_nodes = lastCall?.soft_incomplete.length ?? 0;
    item.final_dsl = lastCall?.dsl ?? "";
    item.hard_error_codes = Array.from(new Set(calls.flatMap((call) => call.hard_errors.map((error) => error.code))));

    if (conformance && cleanCall) {
      const { graph } = compileCanvasDsl(cleanCall.dsl, { workflowTools: tools });
      item.conformance = conformGraph(graph, tools);
    }
    const usage = aggregateUsage(agent.state.messages);
    if (usage) item.usage = usage;
  } catch (error) {
    item.collector_error = `${(error as Error).name || "Error"}: ${(error as Error).message}`;
  } finally {
    item.completed_at = new Date().toISOString();
    item.duration_seconds = Math.round(performance.now() - started) / 1000;
  }
  return item;
}

function summarize(rounds: RoundEvidence[]): Record<string, unknown> {
  const durations = rounds.map((item) => item.duration_seconds);
  const nodes = rounds.map((item) => item.node_count);
  const mean = (values: number[]) =>
    values.length > 0 ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100 : null;
  const codes: Record<string, number> = {};
  for (const item of rounds) for (const code of item.hard_error_codes) codes[code] = (codes[code] || 0) + 1;
  const conformanceResults = rounds.flatMap((item) => (item.conformance ? [item.conformance] : []));
  const conformanceAccepted = conformanceResults.filter((result) => result.accepted).length;
  const usageResults = rounds.flatMap((item) => (item.usage ? [item.usage] : []));
  const usageSum = (key: "input" | "output" | "cacheRead" | "cacheWrite" | "reasoning" | "totalTokens") =>
    usageResults.reduce((sum, item) => sum + item[key], 0);
  return {
    rounds_requested: rounds.length,
    rounds_completed: rounds.filter((item) => !item.collector_error).length,
    rounds_success: rounds.filter((item) => item.success).length,
    rounds_first_pass: rounds.filter((item) => item.first_pass).length,
    first_pass_rate: Math.round((rounds.filter((item) => item.first_pass).length / rounds.length) * 100) / 100,
    success_rate: Math.round((rounds.filter((item) => item.success).length / rounds.length) * 100) / 100,
    mean_duration_seconds: mean(durations),
    mean_node_count: mean(nodes),
    mean_tool_calls: mean(rounds.map((item) => item.tool_calls)),
    node_counts: nodes,
    hard_error_codes: codes,
    llm_mean_first_ms: mean(rounds.map((item) => item.attempts[0]?.llm_duration_ms ?? 0)),
    conformance_submitted: conformanceResults.length,
    conformance_accepted: conformanceAccepted,
    conformance_rate:
      conformanceResults.length > 0 ? Math.round((conformanceAccepted / conformanceResults.length) * 100) / 100 : null,
    conformance_errors: conformanceResults
      .filter((result) => !result.accepted)
      .map((result) => result.error_code || "unknown"),
    usage_rounds: usageResults.length,
    usage_total_input: usageSum("input"),
    usage_total_output: usageSum("output"),
    usage_total_cache_read: usageSum("cacheRead"),
    usage_total_cache_write: usageSum("cacheWrite"),
    usage_total_reasoning: usageSum("reasoning"),
    usage_total_tokens: usageSum("totalTokens"),
    usage_mean_tokens: mean(usageResults.map((item) => item.totalTokens)),
    usage_mean_llm_calls: mean(usageResults.map((item) => item.llm_calls)),
  };
}

function renderMarkdown(report: Record<string, unknown>): string {
  const summary = report.summary as Record<string, unknown>;
  const meanDuration = summary.mean_duration_seconds as number | null;
  const meanNodes = summary.mean_node_count as number | null;
  const lines = [
    "# Canvas DSL Harness Report（arm: dsl-tool）",
    "",
    `- Prompt: ${report.prompt as string}`,
    `- Rounds: ${summary.rounds_completed as number}/${summary.rounds_requested as number} completed`,
    `- Success: ${summary.rounds_success as number} / First-pass: ${summary.rounds_first_pass as number} (${summary.first_pass_rate as number})`,
    `- Mean duration: ${meanDuration ?? "n/a"} s`,
    `- Mean nodes: ${meanNodes ?? "n/a"} / Mean tool calls: ${summary.mean_tool_calls ?? "n/a"}`,
    `- LLM mean first duration: ${summary.llm_mean_first_ms ?? "n/a"} ms`,
    `- Conformance: ${summary.conformance_accepted ?? 0}/${summary.conformance_submitted ?? 0} accepted (${summary.conformance_rate ?? "n/a"})`,
    `- Token usage: ${summary.usage_rounds ?? 0} rounds measured; total input=${summary.usage_total_input ?? 0} output=${summary.usage_total_output ?? 0} cacheRead=${summary.usage_total_cache_read ?? 0} reasoning=${summary.usage_total_reasoning ?? 0} total=${summary.usage_total_tokens ?? 0}`,
    "",
    "## Hard error codes",
    "",
    "| Code | Count |",
    "|---|---:|",
  ];
  const codes = summary.hard_error_codes as Record<string, number>;
  for (const [code, count] of Object.entries(codes).sort((a, b) => b[1] - a[1])) {
    lines.push(`| \`${code}\` | ${count} |`);
  }
  if (Object.keys(codes).length === 0) lines.push("| none | 0 |");
  lines.push(
    "",
    "## Rounds",
    "",
    "| Round | Success | First pass | Nodes | Tool calls | Duration (s) | Hard errors | Conformance |",
  );
  for (const item of report.rounds as RoundEvidence[]) {
    const errors = item.attempts.flatMap((attempt) => attempt.hard_errors);
    const conformance = item.conformance
      ? item.conformance.accepted
        ? `accept ${item.conformance.harness_nodes}/${item.conformance.compiler_nodes}`
        : `reject: ${item.conformance.error_code || "unknown"}`
      : "—";
    lines.push(
      `| ${item.round} | ${item.success ? "yes" : "no"} | ${item.first_pass ? "yes" : "no"} | ${item.node_count} | ` +
        `${item.tool_calls} | ${item.duration_seconds} | ${errors.length} | ${conformance} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<number> {
  loadRootEnv();
  const args = parseArgs(process.argv.slice(2));
  const reportDir = args.reportDir || defaultReportDir();
  fs.mkdirSync(reportDir, { recursive: true });

  const { token } = await registerUser(args.baseUrl);
  const tools = await fetchWorkflowTools(args.baseUrl, token);
  const systemPrompt = [
    CANVAS_DSL_GRAMMAR_PROMPT,
    renderWorkflowDslCatalog(tools),
    "",
    "## 任务",
    "使用 apply_canvas_dsl 工具提交你的 DSL。工具会编译校验：失败会返回诊断，请修正后重新调用；成功会返回节点数。",
    "不要用其他方式输出 DSL，也不要重复提交相同的 DSL。",
    "只要 apply_canvas_dsl 返回任何诊断（语法错误、未知工作流、未定义引用、缺少输入等），你必须修正 DSL 并重新调用本工具，直到返回成功为止，不得提前结束回合。编译成功后简短确认即可。",
  ].join("\n");

  const report: Record<string, unknown> = {
    schema_version: 2,
    started_at: new Date().toISOString(),
    base_url: args.baseUrl,
    prompt: args.prompt,
    workflow_tools_count: tools.length,
    workflow_ids: tools.map((tool) => tool.id).sort(),
    rounds: [],
  };
  const rounds: RoundEvidence[] = [];
  for (let roundIndex = 1; roundIndex <= args.rounds; roundIndex += 1) {
    console.log(`[${roundIndex}/${args.rounds}] starting DSL tool round`, new Date().toISOString());
    const item = await runRound(systemPrompt, args.prompt, tools, roundIndex, args.conformance);
    const roundPath = path.join(reportDir, `round-${String(roundIndex).padStart(3, "0")}.json`);
    fs.writeFileSync(roundPath, `${JSON.stringify(item, null, 2)}\n`);
    item.evidence_file = roundPath;
    rounds.push(item);
    console.log(
      `[${roundIndex}/${args.rounds}] ${item.collector_error ? "ERROR" : "DONE"} success=${item.success} ` +
        `first_pass=${item.first_pass} nodes=${item.node_count} calls=${item.tool_calls} duration=${item.duration_seconds}s`,
    );
  }
  report.completed_at = new Date().toISOString();
  report.rounds = rounds;
  report.summary = summarize(rounds);
  const batchPath = path.join(reportDir, "batch.json");
  const markdownPath = path.join(reportDir, "summary.md");
  fs.writeFileSync(batchPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(markdownPath, renderMarkdown(report));
  console.log(`batch report: ${batchPath}`);
  console.log(`summary: ${markdownPath}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`[FAIL] ${(error as Error).message}`);
    process.exit(1);
  });
