// 构建 Web 产物：esbuild 打包 TS，再复制静态资源（HTML/CSS）到 dist/web。
import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist', 'web');

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [join(root, 'src/web/main.ts'), join(root, 'src/web/worker.ts')],
  bundle: true,
  format: 'esm',
  outdir: outDir,
  sourcemap: true,
  logLevel: 'info',
});

await copyFile(join(root, 'src/web/index.html'), join(outDir, 'index.html'));
await copyFile(join(root, 'src/web/styles.css'), join(outDir, 'styles.css'));
console.log('Web 产物已生成到 dist/web');
