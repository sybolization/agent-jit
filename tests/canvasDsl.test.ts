import { Value } from "typebox/value";
import { describe, expect, test } from "vitest";
import type { CanvasWorkflowTool } from "../contracts/canvas.js";
import { SemanticCanvasGraphV1Schema, SemanticCanvasNodeV1Schema } from "../contracts/semanticCanvas.js";
import { CanvasDslCompileError, compileCanvasDsl } from "../domain/canvas/canvasDsl.js";
import { toSemanticCanvasGraph } from "../domain/canvas/semanticGraph.js";

const imageVideoTools: CanvasWorkflowTool[] = [
  {
    id: "text_to_image",
    outputKind: "image",
    parameters: [
      { key: "prompt", kind: "text", required: true },
      { key: "seed", kind: "int", required: false },
    ],
  },
  {
    id: "image_to_video",
    outputKind: "video",
    references: [{ parameterKey: "reference_image", kind: "image", required: true }],
    parameters: [
      { key: "prompt", kind: "text", required: true },
      { key: "seed", kind: "int", required: false },
    ],
  },
];

describe("compileCanvasDsl — basic workflow", () => {
  test("compiles a single workflow node to the same semantic graph as hand-written JSON", () => {
    const dsl = compileCanvasDsl('img = text_to_image(prompt="a cat", seed=7)', {
      workflowTools: imageVideoTools,
      canvasVersion: "v1",
    });
    const json = toSemanticCanvasGraph(
      {
        nodes: [
          {
            id: "img",
            type: "workflow",
            data: { workflowId: "text_to_image", inputValues: { prompt: "a cat", seed: 7 } },
          },
        ],
        edges: [],
      },
      { canvasVersion: "v1", workflowTools: imageVideoTools },
    );
    expect(Value.Check(SemanticCanvasGraphV1Schema, dsl.graph)).toBe(true);
    expect(JSON.parse(JSON.stringify(dsl.graph))).toEqual(JSON.parse(JSON.stringify(json)));
  });

  test("compiles an image -> video chain with a node reference to the same graph as JSON with an edge", () => {
    const source = [
      'img = text_to_image(prompt="a cat")',
      'clip = image_to_video(reference_image=img, prompt="moving", seed=5)',
    ].join("\n");
    const dsl = compileCanvasDsl(source, { workflowTools: imageVideoTools, canvasVersion: "v1" });
    const json = toSemanticCanvasGraph(
      {
        nodes: [
          { id: "img", type: "workflow", data: { workflowId: "text_to_image", inputValues: { prompt: "a cat" } } },
          {
            id: "clip",
            type: "workflow",
            data: { workflowId: "image_to_video", inputValues: { prompt: "moving", seed: 5 } },
          },
        ],
        edges: [{ id: "e1", source: "img", target: "clip", data: { parameterKey: "reference_image" } }],
      },
      { canvasVersion: "v1", workflowTools: imageVideoTools },
    );
    expect(JSON.parse(JSON.stringify(dsl.graph))).toEqual(JSON.parse(JSON.stringify(json)));
  });

  test("accepts numbers, booleans, null, and negative values for declared parameters", () => {
    const tools: CanvasWorkflowTool[] = [
      {
        id: "editor",
        outputKind: "image",
        parameters: [
          { key: "prompt", kind: "text", required: true },
          { key: "seed", kind: "int" },
          { key: "steps", kind: "int" },
          { key: "scale", kind: "number" },
          { key: "enable", kind: "boolean" },
          { key: "extra", kind: "text" },
        ],
      },
    ];
    const result = compileCanvasDsl('n = editor(prompt="x", seed=42, steps=-1, scale=1.5, enable=true, extra=null)', {
      workflowTools: tools,
    });
    const node = result.graph.nodes[0];
    expect(node?.config).toEqual({
      enable: true,
      extra: null,
      prompt: "x",
      scale: 1.5,
      seed: 42,
      steps: -1,
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("compiles builtin text and asset nodes", () => {
    const result = compileCanvasDsl(
      'note = text(text="片头说明")\ncover = asset(asset_id="asset-cover", asset_kind="image", file_name="cover.png")',
    );
    const byId = Object.fromEntries(result.graph.nodes.map((item) => [item.id, item]));
    expect(byId["note"]).toMatchObject({
      kind: "text",
      inputs: { text: { kind: "literal", value: "片头说明" } },
      outputs: [{ name: "text", type: "text" }],
    });
    expect(byId["cover"]).toMatchObject({
      kind: "asset",
      config: { asset_id: "asset-cover", asset_kind: "image", file_name: "cover.png" },
      outputs: [{ name: "image", type: "image" }],
    });
  });
});

describe("compileCanvasDsl — hard errors", () => {
  function collectCodes(fn: () => unknown): string[] {
    try {
      fn();
    } catch (error) {
      if (error instanceof CanvasDslCompileError) return error.diagnostics.map((item) => item.code);
    }
    throw new Error("expected CanvasDslCompileError");
  }

  test("reports unknown tool, undefined reference, and duplicate name in one batch", () => {
    const codes = collectCodes(() =>
      compileCanvasDsl(
        [
          'img = text_to_image(prompt="a")',
          'bad = unknown_tool(prompt="x")',
          "ghost = image_to_video(reference_image=nowhere)",
          'img = text_to_image(prompt="dup")',
        ].join("\n"),
        { workflowTools: imageVideoTools },
      ),
    );
    expect(codes).toEqual(expect.arrayContaining(["unknown_tool", "undefined_reference", "duplicate_name"]));
  });

  test("reports syntax errors with line numbers", () => {
    expect(() =>
      compileCanvasDsl('broken = text_to_image(prompt "a")\nimg = text_to_image(prompt="ok")', {
        workflowTools: imageVideoTools,
      }),
    ).toThrowError(/syntax/);
  });

  test("rejects duplicate argument, config referencing a node, and forbidden/volatile keys", () => {
    const duplicate = collectCodes(() =>
      compileCanvasDsl('x = text_to_image(prompt="a", prompt="b")', { workflowTools: imageVideoTools }),
    );
    expect(duplicate).toContain("duplicate_argument");

    const refIntoConfig = collectCodes(() =>
      compileCanvasDsl('img = text_to_image(prompt="a")\nx = text_to_image(prompt=img)', {
        workflowTools: imageVideoTools,
      }),
    );
    expect(refIntoConfig).toContain("invalid_reference");

    const forbiddenKey = collectCodes(() =>
      compileCanvasDsl('x = text_to_image(prompt="a", position="nope")', { workflowTools: imageVideoTools }),
    );
    expect(forbiddenKey).toContain("invalid_key");
  });

  test("rejects forward references to keep the graph acyclic by construction", () => {
    const codes = collectCodes(() =>
      compileCanvasDsl('clip = image_to_video(reference_image=img, prompt="x")\nimg = text_to_image(prompt="a")', {
        workflowTools: imageVideoTools,
      }),
    );
    expect(codes).toContain("undefined_reference");
  });

  test("rejects a type-mismatched node reference (image node -> video port)", () => {
    const tools: CanvasWorkflowTool[] = [
      ...imageVideoTools,
      {
        id: "video_merge",
        outputKind: "video",
        references: [{ parameterKey: "first", kind: "video", required: true }],
      },
    ];
    const codes = collectCodes(() =>
      compileCanvasDsl('img = text_to_image(prompt="a")\nmerged = video_merge(first=img)', { workflowTools: tools }),
    );
    expect(codes).toContain("type_mismatch");
  });

  test("rejects an undeclared parameter with unknown_parameter (mirrors Harness config_field_not_declared)", () => {
    const codes = collectCodes(() =>
      compileCanvasDsl('img = text_to_image(prompt="a", positive_prompt="b")', { workflowTools: imageVideoTools }),
    );
    expect(codes).toContain("unknown_parameter");
  });

  test("rejects a kind-mismatched config literal with config_type_mismatch (mirrors Harness config_type_mismatch)", () => {
    const codes = collectCodes(() =>
      compileCanvasDsl('img = text_to_image(prompt="a", seed="abc")', { workflowTools: imageVideoTools }),
    );
    expect(codes).toContain("config_type_mismatch");
  });

  test("rejects a boolean where an integer is declared", () => {
    const codes = collectCodes(() =>
      compileCanvasDsl('img = text_to_image(prompt="a", seed=true)', { workflowTools: imageVideoTools }),
    );
    expect(codes).toContain("config_type_mismatch");
  });

  test("normalizes numeric strings for numeric parameters like the Harness", () => {
    const result = compileCanvasDsl('img = text_to_image(prompt="a", seed="42")', { workflowTools: imageVideoTools });
    expect(result.graph.nodes[0]?.config).toMatchObject({ seed: 42 });
    expect(result.diagnostics).toEqual([]);
  });

  test("builtin text/asset nodes keep free-form config (no unknown_parameter)", () => {
    const result = compileCanvasDsl('cover = asset(asset_id="a", asset_kind="image", anything="goes", count=3)');
    expect(result.graph.nodes[0]?.config).toMatchObject({ anything: "goes", count: 3 });
    expect(result.diagnostics).toEqual([]);
  });
});

describe("compileCanvasDsl — targeted diagnostic hints", () => {
  function suggestions(source: string): string[] {
    try {
      compileCanvasDsl(source, { workflowTools: imageVideoTools });
      return [];
    } catch (error) {
      if (error instanceof CanvasDslCompileError) return error.diagnostics.map((item) => item.suggestion ?? "");
      throw error;
    }
  }

  test("calling a previously defined node as a workflow gets a node-reference hint", () => {
    const hints = suggestions('a = text(text="x")\nb = a');
    expect(hints.join("\n")).toContain("先前定义的节点");
    expect(hints.join("\n")).toContain("工作流(输入名 = a)");
  });

  test("missing parenthesis on a plain workflow gets a single-line hint", () => {
    const hints = suggestions("img = text_to_image");
    expect(hints.join("\n")).toContain("单行调用");
    expect(hints.join("\n")).toContain("参数不要换行缩进");
  });

  test("a stray parameter line (Python-style layout) gets a single-line hint", () => {
    const hints = suggestions('img = text_to_image(prompt="a")\nnegative_prompt = "nope"');
    expect(hints.join("\n")).toContain("逐行写参数");
  });
});

describe("compileCanvasDsl — soft diagnostics", () => {
  test("missing required reference input produces an incomplete node, not a throw", () => {
    const result = compileCanvasDsl('clip = image_to_video(prompt="moving")', { workflowTools: imageVideoTools });
    const node = result.graph.nodes[0];
    expect(node?.readiness).toEqual({
      status: "incomplete",
      missing_inputs: ["reference_image"],
      invalid_inputs: [],
    });
    expect(result.diagnostics.map((item) => item.code)).toEqual(["incomplete_input"]);
  });
});

describe("compileCanvasDsl — hard prompt case (60+ node complex workflow)", () => {
  const productionTools: CanvasWorkflowTool[] = [
    {
      id: "text_to_image",
      outputKind: "image",
      parameters: [
        { key: "prompt", kind: "text", required: true },
        { key: "seed", kind: "int" },
        { key: "width", kind: "int" },
        { key: "height", kind: "int" },
      ],
    },
    {
      id: "image_filter",
      outputKind: "image",
      references: [{ parameterKey: "reference_image", kind: "image", required: true }],
      parameters: [
        { key: "prompt", kind: "text" },
        { key: "strength", kind: "float" },
      ],
    },
    {
      id: "image_upscale",
      outputKind: "image",
      references: [{ parameterKey: "reference_image", kind: "image", required: true }],
      parameters: [{ key: "scale", kind: "float" }],
    },
    {
      id: "image_to_video",
      outputKind: "video",
      references: [{ parameterKey: "reference_image", kind: "image", required: true }],
      parameters: [
        { key: "prompt", kind: "text", required: true },
        { key: "seed", kind: "int" },
      ],
    },
    {
      id: "video_filter",
      outputKind: "video",
      references: [{ parameterKey: "reference_video", kind: "video", required: true }],
      parameters: [{ key: "prompt", kind: "text" }],
    },
    {
      id: "video_audio_mix",
      outputKind: "video",
      references: [
        { parameterKey: "reference_video", kind: "video", required: true },
        { parameterKey: "reference_audio", kind: "audio", required: true },
      ],
      parameters: [{ key: "volume", kind: "float" }],
    },
    {
      id: "video_subtitle",
      outputKind: "video",
      references: [{ parameterKey: "reference_video", kind: "video", required: true }],
      parameters: [{ key: "text", kind: "text", required: true }],
    },
    {
      id: "audio_generate",
      outputKind: "audio",
      parameters: [
        { key: "prompt", kind: "text", required: true },
        { key: "duration_sec", kind: "float" },
      ],
    },
    {
      id: "video_merge",
      outputKind: "video",
      references: [
        { parameterKey: "first", kind: "video", required: true },
        { parameterKey: "second", kind: "video", required: true },
      ],
      parameters: [{ key: "transition", kind: "text" }],
    },
    {
      id: "video_export",
      outputKind: "video",
      references: [{ parameterKey: "reference_video", kind: "video", required: true }],
      parameters: [
        { key: "format", kind: "text" },
        { key: "fps", kind: "int" },
        { key: "resolution", kind: "text" },
      ],
    },
  ];

  // Multi-character cinematic pipeline: images -> refine -> upscale -> video ->
  // filter -> audio mix -> subtitle -> merge -> export (70 nodes, no control flow).
  const complexProgram = [
    "# 角色与场景图像",
    'c1_pose = text_to_image(prompt="英雄角色半身像，冷色调", seed=101, width=1024, height=1536)',
    'c2_pose = text_to_image(prompt="反派角色半身像，暗色调", seed=102, width=1024, height=1536)',
    'c3_pose = text_to_image(prompt="盟友角色半身像，暖色调", seed=103, width=1024, height=1536)',
    'c1_alt = text_to_image(prompt="英雄角色另一角度", seed=104, width=1024, height=1536)',
    'c2_alt = text_to_image(prompt="反派角色另一角度", seed=105, width=1024, height=1536)',
    'c3_alt = text_to_image(prompt="盟友角色另一角度", seed=106, width=1024, height=1536)',
    'bg_day = text_to_image(prompt="白天的城市街道", seed=107, width=1920, height=1080)',
    'bg_night = text_to_image(prompt="夜晚的霓虹街景", seed=108, width=1920, height=1080)',
    'title_card = text_to_image(prompt="电影标题卡", seed=109, width=1920, height=1080)',
    "# 细化",
    'c1_pose_refine = image_filter(reference_image=c1_pose, prompt="提升质感", strength=0.5)',
    'c2_pose_refine = image_filter(reference_image=c2_pose, prompt="提升质感", strength=0.5)',
    'c3_pose_refine = image_filter(reference_image=c3_pose, prompt="提升质感", strength=0.5)',
    'c1_alt_refine = image_filter(reference_image=c1_alt, prompt="提升质感", strength=0.5)',
    'c2_alt_refine = image_filter(reference_image=c2_alt, prompt="提升质感", strength=0.5)',
    'c3_alt_refine = image_filter(reference_image=c3_alt, prompt="提升质感", strength=0.5)',
    'bg_day_refine = image_filter(reference_image=bg_day, prompt="提亮", strength=0.3)',
    'bg_night_refine = image_filter(reference_image=bg_night, prompt="增强对比", strength=0.4)',
    'title_refine = image_filter(reference_image=title_card, prompt="电影感", strength=0.6)',
    "# 放大",
    "c1_hi = image_upscale(reference_image=c1_pose_refine, scale=2.0)",
    "c2_hi = image_upscale(reference_image=c2_pose_refine, scale=2.0)",
    "c3_hi = image_upscale(reference_image=c3_pose_refine, scale=2.0)",
    "c1_alt_hi = image_upscale(reference_image=c1_alt_refine, scale=2.0)",
    "c2_alt_hi = image_upscale(reference_image=c2_alt_refine, scale=2.0)",
    "c3_alt_hi = image_upscale(reference_image=c3_alt_refine, scale=2.0)",
    "bg_day_hi = image_upscale(reference_image=bg_day_refine, scale=2.0)",
    "bg_night_hi = image_upscale(reference_image=bg_night_refine, scale=2.0)",
    "title_hi = image_upscale(reference_image=title_refine, scale=2.0)",
    "# 动画",
    'c1_pose_video = image_to_video(reference_image=c1_hi, prompt="缓慢转身", seed=201)',
    'c2_pose_video = image_to_video(reference_image=c2_hi, prompt="冷笑", seed=202)',
    'c3_pose_video = image_to_video(reference_image=c3_hi, prompt="点头", seed=203)',
    'c1_alt_video = image_to_video(reference_image=c1_alt_hi, prompt="奔跑", seed=204)',
    'c2_alt_video = image_to_video(reference_image=c2_alt_hi, prompt="逼近镜头", seed=205)',
    'c3_alt_video = image_to_video(reference_image=c3_alt_hi, prompt="跟随", seed=206)',
    'bg_day_video = image_to_video(reference_image=bg_day_hi, prompt="航拍推移", seed=207)',
    'bg_night_video = image_to_video(reference_image=bg_night_hi, prompt="霓虹流动", seed=208)',
    'title_video = image_to_video(reference_image=title_hi, prompt="标题浮现", seed=209)',
    "# 视频滤镜",
    'c1_vf = video_filter(reference_video=c1_pose_video, prompt="电影色调")',
    'c2_vf = video_filter(reference_video=c2_pose_video, prompt="低饱和")',
    'c3_vf = video_filter(reference_video=c3_pose_video, prompt="暖色调")',
    "c1_alt_vf = video_filter(reference_video=c1_alt_video)",
    "c2_alt_vf = video_filter(reference_video=c2_alt_video)",
    "c3_alt_vf = video_filter(reference_video=c3_alt_video)",
    'bg_day_vf = video_filter(reference_video=bg_day_video, prompt="日光增强")',
    'bg_night_vf = video_filter(reference_video=bg_night_video, prompt="夜景增强")',
    "title_vf = video_filter(reference_video=title_video)",
    "# 音频",
    'theme_audio = audio_generate(prompt="史诗主题曲", duration_sec=60.0)',
    'sfx_wind = audio_generate(prompt="风声环境音", duration_sec=30.0)',
    'sfx_rain = audio_generate(prompt="雨声", duration_sec=20.0)',
    "# 混音",
    "c1_audio = video_audio_mix(reference_video=c1_vf, reference_audio=theme_audio, volume=0.9)",
    "c2_audio = video_audio_mix(reference_video=c2_vf, reference_audio=theme_audio, volume=0.8)",
    "c3_audio = video_audio_mix(reference_video=c3_vf, reference_audio=theme_audio, volume=0.9)",
    "c1_alt_audio = video_audio_mix(reference_video=c1_alt_vf, reference_audio=sfx_wind, volume=0.7)",
    "c2_alt_audio = video_audio_mix(reference_video=c2_alt_vf, reference_audio=theme_audio, volume=0.8)",
    "c3_alt_audio = video_audio_mix(reference_video=c3_alt_vf, reference_audio=sfx_wind, volume=0.7)",
    "bg_day_audio = video_audio_mix(reference_video=bg_day_vf, reference_audio=sfx_wind, volume=0.6)",
    "bg_night_audio = video_audio_mix(reference_video=bg_night_vf, reference_audio=sfx_rain, volume=0.6)",
    "title_audio = video_audio_mix(reference_video=title_vf, reference_audio=theme_audio, volume=1.0)",
    "# 字幕",
    'c1_sub = video_subtitle(reference_video=c1_audio, text="第一幕")',
    'c2_sub = video_subtitle(reference_video=c2_audio, text="第二幕")',
    'c3_sub = video_subtitle(reference_video=c3_audio, text="第三幕")',
    'title_sub = video_subtitle(reference_video=title_audio, text="Workbench 演示")',
    "# 合并与导出",
    "m1 = video_merge(first=c1_sub, second=c2_sub)",
    "m2 = video_merge(first=m1, second=c3_sub)",
    "m3 = video_merge(first=c1_alt_audio, second=c2_alt_audio)",
    "m4 = video_merge(first=c3_alt_audio, second=bg_day_audio)",
    "m5 = video_merge(first=bg_night_audio, second=title_sub)",
    "m6 = video_merge(first=m2, second=m3)",
    "m7 = video_merge(first=m4, second=m5)",
    "m8 = video_merge(first=m6, second=m7)",
    'final = video_export(reference_video=m8, format="mp4", fps=24, resolution="1920x1080")',
  ].join("\n");

  test("compiles 70 nodes, all schema-valid, all complete, deterministic, and acyclic", () => {
    const first = compileCanvasDsl(complexProgram, { workflowTools: productionTools, canvasVersion: "v-hard" });
    const second = compileCanvasDsl(complexProgram, { workflowTools: productionTools, canvasVersion: "v-hard" });

    expect(first.diagnostics).toEqual([]);
    expect(first.graph.nodes.length).toBeGreaterThanOrEqual(60);
    expect(first.graph.nodes).toHaveLength(70);
    expect(Value.Check(SemanticCanvasGraphV1Schema, first.graph)).toBe(true);
    for (const node of first.graph.nodes) {
      expect(Value.Check(SemanticCanvasNodeV1Schema, node)).toBe(true);
      expect(node.readiness.status).toBe("complete");
    }
    expect(JSON.stringify(first.graph)).toBe(JSON.stringify(second.graph));

    const ids = new Set(first.graph.nodes.map((node) => node.id));
    const refs = first.graph.nodes.flatMap((node) =>
      Object.values(node.inputs).flatMap((input) => {
        const bindings = Array.isArray(input) ? input : [input];
        return bindings.flatMap((binding) => (binding.kind === "node_output" ? [binding.node_id] : []));
      }),
    );
    for (const ref of refs) expect(ids.has(ref)).toBe(true);

    const finalNode = first.graph.nodes.find((node) => node.id === "final");
    expect(finalNode?.inputs.reference_video).toEqual({ kind: "node_output", node_id: "m8", output: "video" });
    expect(finalNode?.config).toEqual({ format: "mp4", fps: 24, resolution: "1920x1080" });
  });
});
