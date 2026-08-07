import { describe, expect, test } from "vitest";

import { compileExecutionDsl } from "../src/compiler/compiler.js";
import { githubTools } from "../src/compiler/registry.js";
import { checkTaskCorrectness, type TaskSpec } from "../src/experiments/taskSpec.js";

const SPEC: TaskSpec = { query: "agent framework", limit: 10, mapKey: "full_name", takeCount: 3 };

function compile(dsl: string) {
  const { graph } = compileExecutionDsl(dsl, { tools: githubTools });
  return graph;
}

const CORRECT = [
  'repos = github.search_repositories(query="agent framework language:typescript", limit=10)',
  'details = map(source=repos, tool="github.get_repository", key="full_name", concurrency=5)',
  "top = take(source=details, count=3)",
  "return(value=top)",
].join("\n");

describe("checkTaskCorrectness", () => {
  test("正确程序通过所有检查项", () => {
    const result = checkTaskCorrectness(compile(CORRECT), SPEC);
    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test("query 不含关键词 → 失败", () => {
    const dsl = CORRECT.replace('"agent framework language:typescript"', '"python web framework"');
    const result = checkTaskCorrectness(compile(dsl), SPEC);
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("query"))).toBe(true);
  });

  test("limit 不是 10 → 失败", () => {
    const dsl = CORRECT.replace("limit=10", "limit=5");
    const result = checkTaskCorrectness(compile(dsl), SPEC);
    expect(result.failures.some((item) => item.includes("limit"))).toBe(true);
  });

  test("map key 不是 full_name → 失败", () => {
    const dsl = CORRECT.replace('key="full_name"', 'key="name"');
    const result = checkTaskCorrectness(compile(dsl), SPEC);
    expect(result.failures.some((item) => item.includes("map 的 key"))).toBe(true);
  });

  test("take count 不是 3 → 失败", () => {
    const dsl = CORRECT.replace("count=3", "count=5");
    const result = checkTaskCorrectness(compile(dsl), SPEC);
    expect(result.failures.some((item) => item.includes("take 的 count"))).toBe(true);
  });

  test("缺少 return → 失败", () => {
    const dsl = CORRECT.split("\n").slice(0, 3).join("\n");
    const result = checkTaskCorrectness(compile(dsl), SPEC);
    expect(result.failures.some((item) => item.includes("return"))).toBe(true);
  });

  test("return 数据流中的冗余 take 不误判（count 只看最终 take）", () => {
    const dsl = [
      'repos = github.search_repositories(query="agent framework language:typescript", limit=10)',
      "repos_taken = take(source=repos, count=10)",
      'details = map(source=repos_taken, tool="github.get_repository", key="full_name", concurrency=5)',
      "top = take(source=details, count=3)",
      "return(value=top)",
    ].join("\n");
    const result = checkTaskCorrectness(compile(dsl), SPEC);
    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test("query 漏掉 language:typescript → 失败（queryTokens 逐 token 检查）", () => {
    const dsl = CORRECT.replace("agent framework language:typescript", "agent framework");
    const result = checkTaskCorrectness(compile(dsl), { ...SPEC, queryTokens: ["agent framework", "language:typescript"] });
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("language:typescript"))).toBe(true);
  });

  test("return 直接引用 map 输出（数据流缺最终 take）→ 失败", () => {
    const dsl = [
      'repos = github.search_repositories(query="agent framework language:typescript", limit=10)',
      'details = map(source=repos, tool="github.get_repository", key="full_name", concurrency=5)',
      "return(value=details)",
    ].join("\n");
    const result = checkTaskCorrectness(compile(dsl), SPEC);
    expect(result.pass).toBe(false);
    expect(result.failures.some((item) => item.includes("take"))).toBe(true);
  });
});
