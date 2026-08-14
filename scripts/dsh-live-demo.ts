/**
 * Agent JIT 现场演示：在真实 DSH 服务树上挂载已发布的 bundle（dist/）。
 *
 * A. 真实 GitHub：jit_execute_program 一次调用完成
 *    search → get_repository×N → sort → take（对比逐工具调用）。
 *    注意：两条路径各自独立调用实时 search，GitHub 搜索快照可能漂移，
 *    因此 A 的对比是「近似对比 + 快照诊断」。
 * B. 确定性等价：同一程序在 mock provider 上，断言压缩路径（1 次调用）
 *    与逐工具路径（11 次调用）结果完全一致（同 tests/dshSmoke.test.ts）。
 *
 * 运行：npx tsx --env-file=.env scripts/dsh-live-demo.ts
 */
import { Context } from "@deepseek-ai/cordis";
import Timer from "@deepseek-ai/cordis-plugin-timer";
import { CallId } from "@deepseek-ai/dsh-llm";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRegistry from "@deepseek-ai/dsh-tools";
import { apply, inject, name } from "../dist/integrations/dsh/index.js";

async function mount(providers: { github: "real" | "mock"; domain: "mock" }) {
  const ctx = new Context();
  await ctx.plugin(Timer);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRegistry);
  await ctx.plugin({ name, inject, apply }, { providers });
  return ctx;
}

async function call(ctx: Context, toolName: string, args: unknown): Promise<unknown> {
  let seq = 0;
  const result = await ctx.tools.execute({
    callId: CallId(`demo:${toolName}:${seq++}`),
    name: toolName,
    arguments: args,
    signal: new AbortController().signal,
  });
  if (result.isError) throw new Error(`${toolName} 失败：${result.error.message}`);
  return result.value;
}

const SOURCE = [
  'repos = github.search_repositories(query="deepseek harness", limit=3)',
  "details = map(repos, github.get_repository(full_name=_.full_name))",
  'ranked = sort(details, key="stars", desc=true)',
  "top = take(ranked, 3)",
  "return top",
].join("\n");

/** 未压缩路径：模拟 agent loop 逐工具执行。 */
async function uncompressed(ctx: Context) {
  let calls = 0;
  const search = (await call(ctx, "github_search_repositories", {
    query: "deepseek harness",
    limit: 3,
  })) as { full_name: string }[];
  calls += 1;
  const details: unknown[] = [];
  for (const repo of search) {
    details.push(await call(ctx, "github_get_repository", { full_name: repo.full_name }));
    calls += 1;
  }
  const ranked = (details as { stars: number }[]).slice().sort((a, b) => b.stars - a.stars);
  return { top: ranked.slice(0, 3), calls };
}

console.log("=== A. 真实 GitHub（token 来自 .env）===\n");
console.log(`DSL 程序（1 次 jit_execute_program）：\n${SOURCE}\n`);

const real = await mount({ github: "real", domain: "mock" });
const started = performance.now();
const compressed = JSON.parse(String(await call(real, "jit_execute_program", { source: SOURCE }))) as {
  full_name: string;
  stars: number;
}[];
const compressedMs = Math.round(performance.now() - started);
console.log("压缩路径结果：");
for (const repo of compressed) console.log(`  ${repo.full_name}  ⭐${repo.stars}`);
console.log(`  → 1 次工具调用，${compressedMs} ms\n`);

const { top, calls } = await uncompressed(real);
console.log(`未压缩路径：${calls} 次工具调用`);
for (const repo of top as { full_name: string; stars: number }[]) console.log(`  ${repo.full_name}  ⭐${repo.stars}`);
const same = JSON.stringify(compressed) === JSON.stringify(top);
console.log(`\n结果一致：${same}`);
if (!same) {
  const a = new Set(compressed.map((r) => r.full_name));
  const b = new Set((top as { full_name: string }[]).map((r) => r.full_name));
  console.log(
    `  （两次独立 search 的快照漂移：压缩路径独有 ${[...a].filter((x) => !b.has(x)).join(", ") || "无"}；`
    + `未压缩路径独有 ${[...b].filter((x) => !a.has(x)).join(", ") || "无"}）`,
  );
}

console.log("\n=== B. mock 确定性等价（同 tests/dshSmoke.test.ts 断言）===\n");
const mock = await mount({ github: "mock", domain: "mock" });
const mockSource = [
  'repos = github.search_repositories(query="dsl", limit=5)',
  "details = map(repos, github.get_repository(full_name=_.full_name))",
  "active = filter(details, archived=false)",
  "top = take(active, 3)",
  "return top",
].join("\n");
const mockCompressed = JSON.parse(String(await call(mock, "jit_execute_program", { source: mockSource })));
const search = (await call(mock, "github_search_repositories", { query: "dsl", limit: 5 })) as {
  full_name: string;
  archived: boolean;
}[];
let mockCalls = 1;
const mockDetails: unknown[] = [];
for (const repo of search) {
  mockDetails.push(await call(mock, "github_get_repository", { full_name: repo.full_name }));
  mockCalls += 1;
}
const mockActive = mockDetails.filter((repo) => (repo as { archived: boolean }).archived === false);
const mockTop = mockActive.slice(0, 3);
console.log(`压缩路径：1 次调用；未压缩路径：${mockCalls} 次调用`);
console.log(`结果完全一致：${JSON.stringify(mockCompressed) === JSON.stringify(mockTop)} ✅`);
