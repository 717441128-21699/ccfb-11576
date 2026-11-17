import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // vitest 通过下面的 test 段读取配置 (类型由 vitest/config 扩展,
  // 此处用 vite 原生 defineConfig 以避免双 vite 副本的类型冲突)
  ...({
    test: {
      globals: true,
      environment: 'node',
      include: ['tests/**/*.test.ts'],
    },
  } as object),
});
