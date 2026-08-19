/**
 * R7 prompt overfit audit（纯函数）。
 *
 * 与 tests/routingToolPrompts.test.ts 的硬断言不同，这里输出**数值证据**：
 * - forbiddenTokenHits：命中防泄漏黑名单的 token；
 * - longestCommonSubstring：prompt 与任务文本的最长公共子串；
 * - sharedCharacterBigrams：字符二元组交集大小；
 * - sharedWordTokens：非字母数字分词后的共同 token。
 *
 * 这些指标只用于报告与审查，不构成新的决策阈值——决策规则只有
 * docs/r7-routing-plan.md 与 r7Decision.ts 中预注册的那套。
 */

import { R7_FORBIDDEN_PROMPT_TOKENS } from "../prompt/routingToolPrompts.js";

export interface PromptOverlapAudit {
  forbiddenTokenHits: readonly string[];
  longestCommonSubstring: string;
  longestCommonSubstringLength: number;
  sharedCharacterBigrams: number;
  sharedWordTokens: readonly string[];
}

function characterBigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, "");
  const out = new Set<string>();
  for (let i = 0; i < normalized.length - 1; i += 1) {
    out.add(normalized.slice(i, i + 2));
  }
  return out;
}

function wordTokens(text: string): Set<string> {
  const matches = text
    .toLowerCase()
    .match(/[a-z0-9_]+|[\u4e00-\u9fff]+/g) ?? [];
  return new Set(matches.filter((token) => token.length >= 2));
}

/** 单个 prompt 文本与多个任务文本的过拟合面审计。 */
export function auditPromptOverlap(promptText: string, taskTexts: readonly string[]): PromptOverlapAudit {
  const forbiddenTokenHits = R7_FORBIDDEN_PROMPT_TOKENS.filter((token) =>
    promptText.toLowerCase().includes(token.toLowerCase()),
  );

  const promptBigrams = characterBigrams(promptText);
  const promptWords = wordTokens(promptText);
  let sharedCharacterBigrams = 0;
  let sharedWordTokens = new Set<string>();
  let longestCommonSubstring = "";
  for (const taskText of taskTexts) {
    const taskBigrams = characterBigrams(taskText);
    for (const bigram of promptBigrams) if (taskBigrams.has(bigram)) sharedCharacterBigrams += 1;
    for (const word of wordTokens(taskText)) if (promptWords.has(word)) sharedWordTokens.add(word);

    const normalizedTask = taskText.toLowerCase();
    for (let i = 0; i < promptText.length; i += 1) {
      for (let j = i + 1; j <= promptText.length; j += 1) {
        const candidate = promptText.slice(i, j);
        if (candidate.length <= longestCommonSubstring.length) continue;
        if (normalizedTask.includes(candidate.toLowerCase())) longestCommonSubstring = candidate;
      }
    }
  }
  return {
    forbiddenTokenHits,
    longestCommonSubstring,
    longestCommonSubstringLength: longestCommonSubstring.length,
    sharedCharacterBigrams,
    sharedWordTokens: [...sharedWordTokens].sort(),
  };
}
