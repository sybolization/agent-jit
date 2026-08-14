import { schemaViewOf, schemaViewText } from "./schemaView.js";
/**
 * Compact LLM Catalog：把 tool registry 自动渲染成给模型的紧凑工具目录
 * （ToolRegistry 的第二个消费者，与 Compiler 并列）。
 *
 * 原则：**工具调用只需要 input contract；工具编排必须同时有 output contract。**
 * - 只渲染契约（inputSchema / outputSchema），绝不渲染真实返回内容或示例 JSON；
 * - 输出对象提取为命名类型（末尾"类型定义"段），**结构相同的类型只展示一次**；
 * - 渲染走 SchemaView 归一（string | null / 嵌套 / union / record），
 *   compiler 内部仍然使用完整 JSON Schema，这里只是给模型的紧凑投影。
 *
 * @deprecated 历史兼容 renderer：新代码请使用 `dslSignature.ts` 的
 * `renderDslSignature`（forward-looking 的 DSL 签名层），不再在此新增渲染逻辑。
 * 本文件的消费入口只剩历史快照/复现路径：
 * - `renderToolContracts`：仅 describe 的 "legacy" 格式（历史 eager 臂）使用；
 * - `renderCompactToolCatalog`：仅嵌入 prompt 的老通道（历史 experiment）。
 */
const VERB_PREFIXES = ["search", "get", "list", "prepare", "fetch", "create", "count", "find", "load"];
/** 末词单数化（仅覆盖常见规则：ies→y、尾 s→空；无法可靠处理的保持原样）。 */
function singularize(word) {
    if (word.endsWith("ies") && word.length > 4)
        return `${word.slice(0, -3)}y`;
    if (word.endsWith("ss") || word.endsWith("us") || word.endsWith("is"))
        return word;
    if (word.endsWith("s") && word.length > 1)
        return word.slice(0, -1);
    return word;
}
function pascalCase(tokens) {
    return tokens.map((token) => (token ? token.charAt(0).toUpperCase() + token.slice(1) : "")).join("");
}
/**
 * 输出对象类型名优先来自 schema metadata：`schema.title` → `schema.$id` → heuristic fallback。
 * 数组取元素对象上的 metadata（RepositorySummary[] 的名字在元素 schema 上）；
 * 外部工具只要声明 title/$id 就能得到稳定类型名，不依赖命名启发式。
 */
function schemaTypeName(schema) {
    if (schema === null || typeof schema !== "object" || Array.isArray(schema))
        return undefined;
    const node = schema;
    if (node.type === "array") {
        const items = node.items;
        if (items !== null && typeof items === "object" && !Array.isArray(items)) {
            const item = items;
            if (typeof item.title === "string" && item.title.length > 0)
                return item.title;
            if (typeof item.$id === "string" && item.$id.length > 0)
                return item.$id;
        }
        return undefined;
    }
    if (typeof node.title === "string" && node.title.length > 0)
        return node.title;
    if (typeof node.$id === "string" && node.$id.length > 0)
        return node.$id;
    return undefined;
}
/**
 * 从工具 id 推导输出类型名：`github.search_repositories` → `RepositorySummary`；
 * 纯动词段（如 `email.prepare`）回退为 `<域名>Result`。
 */
function typeNameFor(id) {
    const segments = id.split(".");
    const domain = segments[0] ?? "result";
    const tokens = (segments[segments.length - 1] ?? "").split("_").filter((token) => token.length > 0);
    let verb = "";
    while (tokens.length > 0 && VERB_PREFIXES.includes(tokens[0])) {
        verb = tokens.shift();
    }
    let name;
    if (tokens.length > 0) {
        tokens[tokens.length - 1] = singularize(tokens[tokens.length - 1] ?? "");
        name = pascalCase(tokens);
    }
    else {
        name = `${pascalCase([domain])}Result`;
    }
    if (verb === "search")
        name += "Summary"; // 搜索返回的是摘要形态
    return name;
}
/** 对象结构指纹：字段按名排序拼接（渲染文本相同即视为同一结构，共享一个类型名）。 */
function shapeKey(fields) {
    return Object.entries(fields)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, view]) => `${key}:${schemaViewText(view)}`)
        .join(",");
}
/** 把命名类型注册表封装成"渲染输出类型"的闭包（array<object> → Name[]，结构去重）。 */
function outputRenderer(named) {
    const register = (view, owner) => {
        const key = shapeKey(view.properties);
        const existing = named.get(key);
        if (existing)
            return existing.name;
        const base = schemaTypeName(owner.outputSchema) ?? typeNameFor(owner.id);
        const taken = new Set([...named.values()].map((item) => item.name));
        let name = base;
        let suffix = 2;
        while (taken.has(name))
            name = `${base}${suffix++}`; // 同名但结构不同 → 追加数字后缀
        named.set(key, { name, fields: view.properties });
        return name;
    };
    return (view, owner) => {
        if (view.kind === "array" && view.items.kind === "object")
            return `${register(view.items, owner)}[]`;
        if (view.kind === "object")
            return register(view, owner);
        return schemaViewText(view); // 原始类型 / record / union / unknown 内联渲染
    };
}
function formatType(type) {
    const fields = Object.entries(type.fields)
        .map(([key, view]) => `  ${key}: ${schemaViewText(view)}`)
        .join("\n");
    return `${type.name} {\n${fields}\n}`;
}
/** 渲染紧凑工具目录（可选子集）。nameTransform 用于与 pi-ai 工具定义的命名保持一致。 */
export function renderToolContracts(catalog, options = {}) {
    const { ids, nameTransform = (id) => id } = options;
    let tools;
    if (ids === undefined) {
        tools = [...catalog.all()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    }
    else {
        // 子集渲染：保持请求顺序（去重），便于 describe_tools 按模型点名的顺序回显
        const order = new Map();
        for (const id of ids)
            if (!order.has(id))
                order.set(id, order.size);
        tools = catalog
            .all()
            .filter((tool) => order.has(tool.id))
            .sort((left, right) => order.get(left.id) - order.get(right.id));
    }
    const named = new Map();
    const outputOf = outputRenderer(named);
    const header = options.header ?? `# 工具目录（紧凑签名）— 共 ${tools.length} 个`;
    const signatures = tools.map((tool) => {
        const inputView = schemaViewOf(tool.inputSchema);
        const required = inputView.kind === "object" ? new Set(inputView.required) : new Set();
        const properties = inputView.kind === "object" ? inputView.properties : {};
        const params = Object.entries(properties)
            .map(([key, prop]) => `  ${key}${required.has(key) ? "" : "?"}: ${schemaViewText(prop)}`)
            .join("\n");
        const call = params.length > 0 ? `${nameTransform(tool.id)}(\n${params}\n)` : `${nameTransform(tool.id)}()`;
        const description = tool.description ? `  # ${tool.description}` : "";
        return `${call} -> ${outputOf(schemaViewOf(tool.outputSchema), tool)}${description}`;
    });
    const signatureBlock = signatures.join("\n\n");
    const typeBlock = named.size > 0
        ? `\n\n## 类型定义（结构相同的类型只展示一次）\n\n${[...named.values()].map(formatType).join("\n\n")}`
        : "";
    return [
        header,
        "# 参数格式：<名称>: <类型>（? = 可选）；输出为命名类型，定义见下方“类型定义”段",
        "",
        signatureBlock + typeBlock,
    ].join("\n");
}
/** 渲染完整工具目录（ToolRegistry 的 LLM Catalog 消费者入口；子集见 renderToolContracts）。 */
export function renderCompactToolCatalog(catalog, nameTransform = (id) => id) {
    return renderToolContracts(catalog, { nameTransform });
}
