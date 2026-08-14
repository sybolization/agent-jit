import { type Static, Type } from "typebox";
/**
 * 通用 ExecutionIR：DSL 编译目标（运行时调度图）。
 *
 * 与画布语义图的区别：这是"LLM 不该直接书写、但必须确定性产出"的
 * 执行物——`tool`（外部 API）、`map`（动态展开）、`compute`（确定性
 * 程序）、`return`（出口）。变量引用定义数据流边。
 */
export declare const ExecutionLiteralSchema: Type.TCyclic<{
    ExecutionLiteral: Type.TUnion<[Type.TNull, Type.TBoolean, Type.TNumber, Type.TString, Type.TArray<Type.TRef<"ExecutionLiteral">>]>;
}, "ExecutionLiteral">;
export declare const ValueExprSchema: Type.TUnion<[Type.TObject<{
    kind: Type.TLiteral<"literal">;
    value: Type.TCyclic<{
        ExecutionLiteral: Type.TUnion<[Type.TNull, Type.TBoolean, Type.TNumber, Type.TString, Type.TArray<Type.TRef<"ExecutionLiteral">>]>;
    }, "ExecutionLiteral">;
}>, Type.TObject<{
    kind: Type.TLiteral<"ref">;
    name: Type.TString;
}>]>;
export declare const ToolNodeSchema: Type.TObject<{
    id: Type.TString;
    kind: Type.TLiteral<"tool">;
    tool: Type.TString;
    args: Type.TRecord<"^.*$", Type.TUnion<[Type.TObject<{
        kind: Type.TLiteral<"literal">;
        value: Type.TCyclic<{
            ExecutionLiteral: Type.TUnion<[Type.TNull, Type.TBoolean, Type.TNumber, Type.TString, Type.TArray<Type.TRef<"ExecutionLiteral">>]>;
        }, "ExecutionLiteral">;
    }>, Type.TObject<{
        kind: Type.TLiteral<"ref">;
        name: Type.TString;
    }>]>>;
}>;
export declare const MapNodeSchema: Type.TObject<{
    id: Type.TString;
    kind: Type.TLiteral<"map">;
    source: Type.TString;
    tool: Type.TString;
    /** element→argument 绑定：工具参数名 → 元素字段路径（如 { full_name: "full_name" }） */
    bindings: Type.TRecord<"^.*$", Type.TString>;
    concurrency: Type.TNumber;
}>;
export declare const ComputeNodeSchema: Type.TObject<{
    id: Type.TString;
    kind: Type.TLiteral<"compute">;
    op: Type.TUnion<[Type.TLiteral<"take">, Type.TLiteral<"filter">, Type.TLiteral<"sort">, Type.TLiteral<"compute">, Type.TLiteral<"select">]>;
    source: Type.TString;
    args: Type.TRecord<"^.*$", Type.TCyclic<{
        ExecutionLiteral: Type.TUnion<[Type.TNull, Type.TBoolean, Type.TNumber, Type.TString, Type.TArray<Type.TRef<"ExecutionLiteral">>]>;
    }, "ExecutionLiteral">>;
    /** R4e：编译期解析好的表达式 AST（op==="compute" 时是 输出字段→AST；op==="select" 时是 { pred: AST }）；args 中保留源码字符串供诊断/图语义检查 */
    expr: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
}>;
/**
 * 按 key 合并字段（canonical 关键字 merge_by_key；join 为遗留别名，编译产物同一节点）。
 * sources[0] 为基准，其余按 key 匹配后附加字段（基准已有字段不覆盖）——语义是
 * "给每条基准记录附加另一批数据的字段"，不是对称合并。
 */
export declare const JoinNodeSchema: Type.TObject<{
    id: Type.TString;
    kind: Type.TLiteral<"join">;
    sources: Type.TArray<Type.TString>;
    key: Type.TString;
}>;
/** concat：真正的列表拼接——按顺序把多个数组拼成一个大数组，元素原样保留，不做任何字段合并。 */
export declare const ConcatNodeSchema: Type.TObject<{
    id: Type.TString;
    kind: Type.TLiteral<"concat">;
    sources: Type.TArray<Type.TString>;
}>;
export declare const ReturnNodeSchema: Type.TObject<{
    id: Type.TString;
    kind: Type.TLiteral<"return">;
    value: Type.TString;
}>;
export declare const ExecutionNodeSchema: Type.TUnion<[Type.TObject<{
    id: Type.TString;
    kind: Type.TLiteral<"tool">;
    tool: Type.TString;
    args: Type.TRecord<"^.*$", Type.TUnion<[Type.TObject<{
        kind: Type.TLiteral<"literal">;
        value: Type.TCyclic<{
            ExecutionLiteral: Type.TUnion<[Type.TNull, Type.TBoolean, Type.TNumber, Type.TString, Type.TArray<Type.TRef<"ExecutionLiteral">>]>;
        }, "ExecutionLiteral">;
    }>, Type.TObject<{
        kind: Type.TLiteral<"ref">;
        name: Type.TString;
    }>]>>;
}>, Type.TObject<{
    id: Type.TString;
    kind: Type.TLiteral<"map">;
    source: Type.TString;
    tool: Type.TString;
    /** element→argument 绑定：工具参数名 → 元素字段路径（如 { full_name: "full_name" }） */
    bindings: Type.TRecord<"^.*$", Type.TString>;
    concurrency: Type.TNumber;
}>, Type.TObject<{
    id: Type.TString;
    kind: Type.TLiteral<"compute">;
    op: Type.TUnion<[Type.TLiteral<"take">, Type.TLiteral<"filter">, Type.TLiteral<"sort">, Type.TLiteral<"compute">, Type.TLiteral<"select">]>;
    source: Type.TString;
    args: Type.TRecord<"^.*$", Type.TCyclic<{
        ExecutionLiteral: Type.TUnion<[Type.TNull, Type.TBoolean, Type.TNumber, Type.TString, Type.TArray<Type.TRef<"ExecutionLiteral">>]>;
    }, "ExecutionLiteral">>;
    /** R4e：编译期解析好的表达式 AST（op==="compute" 时是 输出字段→AST；op==="select" 时是 { pred: AST }）；args 中保留源码字符串供诊断/图语义检查 */
    expr: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
}>, Type.TObject<{
    id: Type.TString;
    kind: Type.TLiteral<"join">;
    sources: Type.TArray<Type.TString>;
    key: Type.TString;
}>, Type.TObject<{
    id: Type.TString;
    kind: Type.TLiteral<"concat">;
    sources: Type.TArray<Type.TString>;
}>, Type.TObject<{
    id: Type.TString;
    kind: Type.TLiteral<"return">;
    value: Type.TString;
}>]>;
export declare const ExecutionGraphSchema: Type.TObject<{
    schema_version: Type.TLiteral<"1">;
    nodes: Type.TArray<Type.TUnion<[Type.TObject<{
        id: Type.TString;
        kind: Type.TLiteral<"tool">;
        tool: Type.TString;
        args: Type.TRecord<"^.*$", Type.TUnion<[Type.TObject<{
            kind: Type.TLiteral<"literal">;
            value: Type.TCyclic<{
                ExecutionLiteral: Type.TUnion<[Type.TNull, Type.TBoolean, Type.TNumber, Type.TString, Type.TArray<Type.TRef<"ExecutionLiteral">>]>;
            }, "ExecutionLiteral">;
        }>, Type.TObject<{
            kind: Type.TLiteral<"ref">;
            name: Type.TString;
        }>]>>;
    }>, Type.TObject<{
        id: Type.TString;
        kind: Type.TLiteral<"map">;
        source: Type.TString;
        tool: Type.TString;
        /** element→argument 绑定：工具参数名 → 元素字段路径（如 { full_name: "full_name" }） */
        bindings: Type.TRecord<"^.*$", Type.TString>;
        concurrency: Type.TNumber;
    }>, Type.TObject<{
        id: Type.TString;
        kind: Type.TLiteral<"compute">;
        op: Type.TUnion<[Type.TLiteral<"take">, Type.TLiteral<"filter">, Type.TLiteral<"sort">, Type.TLiteral<"compute">, Type.TLiteral<"select">]>;
        source: Type.TString;
        args: Type.TRecord<"^.*$", Type.TCyclic<{
            ExecutionLiteral: Type.TUnion<[Type.TNull, Type.TBoolean, Type.TNumber, Type.TString, Type.TArray<Type.TRef<"ExecutionLiteral">>]>;
        }, "ExecutionLiteral">>;
        /** R4e：编译期解析好的表达式 AST（op==="compute" 时是 输出字段→AST；op==="select" 时是 { pred: AST }）；args 中保留源码字符串供诊断/图语义检查 */
        expr: Type.TOptional<Type.TRecord<"^.*$", Type.TUnknown>>;
    }>, Type.TObject<{
        id: Type.TString;
        kind: Type.TLiteral<"join">;
        sources: Type.TArray<Type.TString>;
        key: Type.TString;
    }>, Type.TObject<{
        id: Type.TString;
        kind: Type.TLiteral<"concat">;
        sources: Type.TArray<Type.TString>;
    }>, Type.TObject<{
        id: Type.TString;
        kind: Type.TLiteral<"return">;
        value: Type.TString;
    }>]>>;
}>;
export type ExecutionLiteral = Static<typeof ExecutionLiteralSchema>;
export type ValueExpr = Static<typeof ValueExprSchema>;
export type ToolNode = Static<typeof ToolNodeSchema>;
export type MapNode = Static<typeof MapNodeSchema>;
export type ComputeNode = Static<typeof ComputeNodeSchema>;
export type JoinNode = Static<typeof JoinNodeSchema>;
export type ConcatNode = Static<typeof ConcatNodeSchema>;
export type ReturnNode = Static<typeof ReturnNodeSchema>;
export type ExecutionNode = Static<typeof ExecutionNodeSchema>;
export type ExecutionGraph = Static<typeof ExecutionGraphSchema>;
