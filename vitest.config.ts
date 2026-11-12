import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
      // 主进程代码里的 electron 依赖在测试里用替身
      electron: resolve(__dirname, 'tests/mocks/electron.ts')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts', 'src/**/*.test.ts'],
    globals: false,
    testTimeout: 60_000
  }
})
