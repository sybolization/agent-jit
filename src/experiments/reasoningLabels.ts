/**
 * 固定 CoT taxonomy（R5.1 Reasoning Observation 的离线人工标注体系）。
 *
 * 设计约束：taxonomy 在实验前固定，避免 post-hoc storytelling（先看结果再编标签）。
 * 仅供离线人工标注 raw CoT traces 使用，不参与 Agent loop，也不被任何运行时逻辑读取。
 */

/** 固定 CoT taxonomy：对模型每轮 reasoning 是否"表现出"某个机制信号打标。 */
export interface BoundaryReasonLabels {
  /** 已意识到后续步骤是确定性的 */
  deterministicPathRecognized: boolean;
  /** 显式考虑过 JIT */
  jitConsidered: boolean;
  /** 决定使用 JIT */
  jitSelected: boolean;
  /** 认为必须先拿到工具结果才能写程序 */
  dataUnknownBlocksOffload: boolean;
  /** 存在真正的语义/控制逻辑不确定性 */
  semanticUncertainty: boolean;
  /** 表现出"先调用一个工具看看"的行为 */
  greedyProbe: boolean;
  /** 担心 describe/compile 启动成本 */
  jitOverheadConcern: boolean;
  /** 认为当前 path 太短不值得 JIT */
  pathTooShort: boolean;
  /** 意识到 atomic 与 JIT 会重复执行 */
  duplicateExecutionAwareness: boolean;
  /** 其他原因（自由文本，标注者补充） */
  other?: string;
}

/** late-offload 五类主因（识别太晚 / 数据不确定性阻塞 / JIT 选择太晚 / 贪婪投机 / 经济性拒绝）。 */
export type LateOffloadCause =
  | "recognition-late"
  | "data-uncertainty-blocker"
  | "jit-selection-late"
  | "greedy-speculative"
  | "economic-rejection";
