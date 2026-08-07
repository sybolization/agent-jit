/**
 * Canvas DSL grammar, written for the LLM (not for the compiler).
 *
 * This prompt fragment teaches the model how to author a canvas graph as
 * code-shaped text instead of JSON. It is consumed by the experiment harness
 * today and can be embedded into the agent system prompt later.
 *
 * The compiler itself lives in `canvasDsl.ts`; keep this document in sync with
 * the compiler's actual grammar and diagnostics (codes listed in section 6).
 */

export const CANVAS_DSL_GRAMMAR_PROMPT = `# 画布 DSL 语法规范（Canvas DSL v1）

你正在用一门专为"画布语义图"设计的小型语言（Canvas DSL）编写生成工作流。DSL 会被编译器**确定性地**翻译成画布语义图（SemanticCanvasGraphV1），由后端执行。你不需要关心坐标、连线、前端展示——你只需要用代码表达"节点 + 参数 + 节点之间的数据流"。

## 1. 语句格式

每条语句定义一个节点，独占一行：

    <节点名称> = <工作流ID或内置节点>(<参数>=<值>, <参数>=<值>, ...)

示例（工作流 ID 必须来自工作流目录）：

    img = text_to_image(prompt="一个女孩站在海边", seed=42, width=1024)
    clip = h17_ltx23_image_video(image=img, prompt="镜头缓慢推进", duration_seconds=6)

- 节点名称：字母或下划线开头，只含字母/数字/下划线，全局唯一。
- 工作流ID：从工作流目录读到的已注册工作流（如 text_to_image、h17_ltx23_image_video）。
- 注释：以 # 开头到行尾，编译器忽略。

> ⚠️ **单行格式（重要）**：每个节点必须**一条语句在一行内写完**，即「名称 = 工作流(参数=值, …)」整行结束。
> 不要模仿 Python 的多行写法（如「名称 = 工作流」独占一行、参数缩进写在下面的行、或括号跨多行）——编译器会把每一行当成一条独立语句，导致大量语法错误。

## 2. 参数值类型

    prompt="字符串"          # 双引号字符串
    seed=42                 # 整数
    scale=1.5               # 小数
    enable=true / false     # 布尔
    extra=null              # 空值
    tags=["a", "b"]         # 字面量数组
    img                     # 裸标识符 = 引用"前面已定义"的节点（见第 3 节）

限制：URL、data URI 不能作为字符串参数（会报 unsupported_literal）。

## 3. 数据流：用节点引用连接节点

裸标识符出现在值的位置 = 引用一个**先前已定义**的节点，编译后成为该输入的上游依赖（node_output 绑定）：

    img = text_to_image(prompt="主角")
    clip = h17_ltx23_image_video(image=img, prompt="转身")

约束：

- 被引用的节点必须在当前语句之前定义（禁止向前引用）。
- 只能把节点接到"引用型输入"上（见第 4 节）。
- 引用的节点输出类型必须与引用型输入的期望类型一致（image/audio/video）；不一致报 type_mismatch。例如 video 端口只能接输出为 video 的节点或 asset(asset_kind="video")。

## 4. 参数路由规则（关键）

每个工作流有两类参数，由工作流目录 Schema 决定：

- **引用型输入**（reference，如 reference_image）：表示"这里要接另一个节点的输出"。值可以写裸标识符（接节点），也可以写字面量（接素材 ID 字符串）。
- **普通参数**（parameter，如 prompt、seed）：节点配置值，**只能写字面量**，不能接节点。参数名必须与工作流目录中该工作流声明的完全一致（不得自创），字面量类型要与声明 kind 匹配（number/boolean/select 等）；自创参数名会报 unknown_parameter，类型不符会报 config_type_mismatch。

把节点接到普通参数上会报 invalid_reference。节点输出类型由工作流目录声明，你不需要自己声明输出。

## 5. 内置节点（不是工作流）

    note = text(text="片头说明")   # 文本节点，所有参数都是字面量输入
    cover = asset(asset_id="asset-1", asset_kind="image", file_name="cover.png")  # 素材节点，参数进 config

## 6. 编译校验与诊断

- **硬错误**（编译失败，需要修订后整段重提）：语法错误、未注册的工作流（unknown_tool）、未定义的引用（undefined_reference）、名称重复（duplicate_name）、参数重复（duplicate_argument）、非法参数名（invalid_key）、普通参数接了节点（invalid_reference）、引用节点类型不匹配（type_mismatch）、未声明参数（unknown_parameter）、字面量类型与参数声明不符（config_type_mismatch）。
- **软提示**（编译仍成功，但节点被标记为不完整）：缺少必填引用输入（incomplete_input）——会列出缺失项，建议补齐后再提交。

错误格式：\`L<行号>: <错误码>: <中文消息>\`。根据错误码和消息修订整段 DSL，再整段重新提交。

## 7. 编写要点

- 为节点取有业务含义的名称（如 hero_portrait、bg_day、final_cut），便于自查与后续修改。
- 复杂工作流可以**分批完成**：先写主体链路，再逐步扩展分支，不要求一次写对。
- **修复纪律**：只要编译器返回任何诊断（语法错误、未知工作流、未定义引用、缺少输入等），你必须**修订 DSL 并重新提交**，直到返回成功为止，不得提前结束。
- 提交前自查：名称唯一、每个引用都有定义、每个工作流都填了必填引用型输入、语句各占一行。

## 8. 完整示例

下面的写法都是**完全正确**的，可作为模板：

    # 示例 A：文生图 → 图生图 → 图生视频 → 拼接成片
    hero  = text_to_image(prompt="电影感英雄半身像，赛博朋克霓虹", seed=101, width=1024)
    scene = image_to_image(image=hero, prompt="夜晚雨夜街景，背景虚化")
    clip  = h17_ltx23_image_video(image=scene, prompt="镜头缓慢推近主角", duration_seconds=6)
    intro = text(text="《霓虹英雄》预告片")
    final = video_concat(video_1=clip, fps=24)

    # 示例 B：素材与音频工作流
    cover = asset(asset_id="asset-cover-01", asset_kind="image")
    voice = asset(asset_id="asset-voice-01", asset_kind="audio")
    music = n7_stable_audio_3_medium(prompt="紧张的电子配乐", duration_seconds=30)
`;
