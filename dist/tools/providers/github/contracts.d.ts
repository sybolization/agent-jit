import { type ToolContract } from "../../definition.js";
/**
 * GitHub 工具契约（唯一事实源，provider 层，与 compiler / runtime 解耦）。
 *
 * 6 个 GitHub 只读工具（read-only），只描述契约（inputSchema / outputSchema），
 * 真实 API 调用在 provider 层（real / mock）注册时补上 execute。编译器据此做
 * `unknown_parameter` / `config_type_mismatch` 校验——LLM 会幻觉合理参数名，
 * 编译期拒绝最可靠。
 */
export declare const githubTools: readonly ToolContract[];
