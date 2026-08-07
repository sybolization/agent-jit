import fs from "node:fs";
import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * 源码按 TS ESM 惯例用 `.js` 后缀导入相邻 `.ts` 文件（如
 * `import ... from "./canvasDsl.js"`）。vitest 4 的模块加载基于 Node 原生
 * ESM 解析，不做 `.js` → `.ts` 映射，因此用一个前置 resolve 插件把相对
 * 路径的 `.js` specifier 改写为实际存在的 `.ts` 绝对路径（存在才接管，
 * 否则放行交给默认解析）。
 */
export default defineConfig({
  plugins: [
    {
      name: "js-specifier-to-ts",
      enforce: "pre",
      resolveId(source, importer) {
        if (!importer || !source.startsWith(".") || !source.endsWith(".js")) return null;
        const tsPath = path.resolve(path.dirname(importer), source.slice(0, -3) + ".ts");
        if (fs.existsSync(tsPath)) return tsPath;
        return null;
      },
    },
  ],
});
