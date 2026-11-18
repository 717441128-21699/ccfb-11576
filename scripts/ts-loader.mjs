/**
 * 开发/测试用 ESM loader：把源码里的 ".js" 相对导入解析到同目录的 ".ts" 文件。
 * 生产 Web 产物由 esbuild 打包，不走这个 loader；Node 24 原生负责擦除类型。
 */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    specifier.endsWith('.js')
  ) {
    const tsCandidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (existsSync(fileURLToPath(tsCandidate))) {
      // 只改解析目标，加载（类型擦除）交给 Node 内置的 TS 支持
      return nextResolve(tsCandidate.href, context);
    }
  }
  return nextResolve(specifier, context);
}

// 让 pathToFileURL 在本文件被引用时保持可用（避免某些宿主的 tree-shaking 告警）
void pathToFileURL;
