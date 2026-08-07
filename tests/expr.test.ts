import { describe, expect, test } from "vitest";

import { evalExpr, parseExpr, isComparisonExpr } from "../src/runtime/expr.js";

describe("parseExpr / evalExpr — 受限表达式求值", () => {
  const evalSrc = (src: string, record: Record<string, unknown>) => {
    const parsed = parseExpr(src);
    if (!parsed.ok) throw new Error(parsed.error);
    return evalExpr(parsed.node, record);
  };

  test("算术：四则 + 括号 + 优先级", () => {
    expect(evalSrc("forks / stars", { forks: 80, stars: 530 })).toBeCloseTo(80 / 530);
    expect(evalSrc("1 + 2 * 3", {})).toBe(7);
    expect(evalSrc("(1 + 2) * 3", {})).toBe(9);
    expect(evalSrc("forks * 2 + 1", { forks: 5 })).toBe(11);
  });

  test("比较：> >= < <= == !=", () => {
    expect(evalSrc("ratio > 0.15", { ratio: 0.2 })).toBe(true);
    expect(evalSrc("ratio > 0.15", { ratio: 0.1 })).toBe(false);
    expect(evalSrc("ratio <= 0.15", { ratio: 0.15 })).toBe(true);
    expect(evalSrc("score >= 100", { score: 100 })).toBe(true);
    expect(evalSrc("language == \"TypeScript\"", { language: "TypeScript" })).toBe(true);
    expect(evalSrc("language != \"Python\"", { language: "TypeScript" })).toBe(true);
  });

  test("字段缺失：undefined 参与比较视为最小", () => {
    expect(evalSrc("score > 100", {})).toBe(false);
    expect(evalSrc("score >= 0", {})).toBe(false);
  });

  test("布尔/字符串字面量", () => {
    expect(evalSrc("true", {})).toBe(true);
    expect(evalSrc("\"abc\"", {})).toBe("abc");
    expect(evalSrc("null", {})).toBe(null);
  });

  test("isComparisonExpr：只有顶层比较才是谓词", () => {
    expect(isComparisonExpr(parseExpr("ratio > 0.15")!.node)).toBe(true);
    expect(isComparisonExpr(parseExpr("score >= 100")!.node)).toBe(true);
    expect(isComparisonExpr(parseExpr("forks / stars")!.node)).toBe(false);
  });

  test("非法表达式报错（拒绝函数调用 / 多余内容 / 空）", () => {
    expect(parseExpr("").ok).toBe(false);
    expect(parseExpr("   ").ok).toBe(false);
    expect(parseExpr("ratio > 0.15 extra").ok).toBe(false);
    expect(parseExpr("fn(1)").ok).toBe(false);
    expect(parseExpr("forks /").ok).toBe(false);
    expect(parseExpr("a..b").ok).toBe(false);
  });
});
