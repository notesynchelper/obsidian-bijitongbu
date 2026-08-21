// 本地复现 Obsidian 官方插件审核 bot 的静态扫描（eslint-plugin-obsidianmd）。
// 跑法（eslint 9 需要 node20）：
//   PATH=$HOME/.nvm/versions/node/v20.20.2/bin:$PATH npx eslint src
import tsparser from '@typescript-eslint/parser'
import { defineConfig } from 'eslint/config'
import obsidianmd from 'eslint-plugin-obsidianmd'

export default defineConfig([
  {
    // 只扫插件源码：tests/__mocks__ 不进发行包，官方扫描也不看它们
    ignores: [
      'node_modules/**',
      'main.js',
      'tests/**',
      'src/__mocks__/**',
      'esbuild.config.mjs',
      'jest.config.js',
      'switch-mode.mjs',
      'coverage/**',
    ],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: './tsconfig.json' },
    },
  },
])
