import { describe, expect, test } from "vitest";
import type { CanvasWorkflowTool } from "../src/contracts/canvas.js";
import { renderWorkflowDslCatalog } from "../src/domain/canvas/canvasDslCatalog.js";

const catalog: CanvasWorkflowTool[] = [
  {
    id: "text_to_image",
    label: "文生图",
    description: "根据文字描述生成图片",
    outputKind: "image",
    parameters: [
      { key: "prompt", kind: "textarea", required: true, default: "" },
      { key: "seed", kind: "number" },
      { key: "filename_prefix", kind: "text" },
    ],
  },
  {
    id: "image_to_image",
    label: "图生图",
    outputKind: "image",
    references: [{ parameterKey: "image", kind: "image", required: true }],
    parameters: [
      { key: "image", kind: "file", required: true },
      { key: "prompt", kind: "textarea", required: true },
      { key: "output_prefix", kind: "text" },
    ],
  },
  {
    id: "n7_stable_audio_3_medium",
    label: "音频生成",
    outputKind: "audio",
    parameters: [
      { key: "prompt", kind: "textarea", required: true },
      { key: "audio_type", kind: "select", required: false, default: "music" },
      { key: "duration_seconds", kind: "number" },
    ],
  },
];

describe("renderWorkflowDslCatalog", () => {
  test("renders one deterministic signature per workflow, sorted by id", () => {
    const first = renderWorkflowDslCatalog(catalog);
    const second = renderWorkflowDslCatalog([...catalog].reverse());
    expect(first).toBe(second);

    const lines = first.split("\n");
    expect(lines[0]).toBe("# 工作流目录（DSL 调用签名）— 共 3 个");
    expect(lines.find((line) => line.startsWith("image_to_image("))).toBeTruthy();
    expect(lines.find((line) => line.startsWith("n7_stable_audio_3_medium("))).toBeTruthy();
    expect(lines.find((line) => line.startsWith("text_to_image("))).toBeTruthy();
    const idIndex = (id: string) => lines.findIndex((line) => line.startsWith(`${id}(`));
    expect(idIndex("image_to_image")).toBeLessThan(idIndex("n7_stable_audio_3_medium"));
    expect(idIndex("n7_stable_audio_3_medium")).toBeLessThan(idIndex("text_to_image"));
  });

  test("marks reference inputs, deduplicates reference/parameter keys, and strips internal keys", () => {
    const rendered = renderWorkflowDslCatalog(catalog);
    const line = rendered.split("\n").find((item) => item.startsWith("image_to_image("));
    expect(line).toBeTruthy();
    if (!line) throw new Error("expected image_to_image line");
    expect(line).toContain("image=image*");
    expect(line).toContain("prompt=text*");
    expect(line).toMatch(/^[^(]+\([^)]*image=[^)]*\)[^#]*# 引用: image/);
    // 只出现一次 image=，引用/参数同名去重
    expect(line.match(/image=/g)).toHaveLength(1);
    // 内部执行键不进入签名
    expect(line).not.toContain("output_prefix");
    expect(rendered).not.toContain("filename_prefix");
  });

  test("marks * only when required and without a default, and normalizes kinds", () => {
    const rendered = renderWorkflowDslCatalog(catalog);
    const t2i = rendered.split("\n").find((item) => item.startsWith("text_to_image("));
    expect(t2i).toContain("prompt=text"); // textarea → text
    // prompt 的默认值是空字符串：hasDefault=true → 不标 *（与 Harness readiness 一致）
    expect(t2i).not.toContain("prompt=text*");
    expect(t2i).toContain("seed=number");

    const audio = rendered.split("\n").find((item) => item.startsWith("n7_stable_audio_3_medium("));
    expect(audio).toContain("prompt=text*");
    expect(audio).toContain("audio_type=text"); // select → text，有默认值且非必填 → 无 *
    expect(audio).not.toContain("audio_type=text*");
  });

  test("renders output kind with fallback and appends reference note + label", () => {
    const rendered = renderWorkflowDslCatalog([...catalog, { id: "no_output", parameters: [] }]);
    const noOutput = rendered.split("\n").find((item) => item.startsWith("no_output("));
    expect(noOutput).toContain("→ output");
    const t2i = rendered.split("\n").find((item) => item.startsWith("text_to_image("));
    expect(t2i).toContain("文生图");
    const i2i = rendered.split("\n").find((item) => item.startsWith("image_to_image("));
    expect(i2i).toContain("图生图");
  });
});
