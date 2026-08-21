process.env.TZ = 'UTC'

module.exports = {
  // The test environment that Jest will use
  testEnvironment: "node",

  // node 环境没有 window；生产代码统一用 window.* 计时器（popout 兼容），
  // 这里给 window → globalThis 的最小别名。
  setupFiles: ["<rootDir>/tests/setup-window-alias.js"],

  // The root directory for Jest tests
  roots: ["<rootDir>/tests"],

  // The file extensions Jest will look for
  moduleFileExtensions: ["ts", "js"],

  // The test regex pattern to match test files
  testRegex: "(/__tests__/.*|(\\.|/)(test|spec))\\.(jsx?|tsx?)$",

  // Exclude the real-Obsidian harness. That subtree has its own Node runner
  // (tests/real-obsidian/run-all.js) — it launches Obsidian under Xvfb and
  // hits a live server, so Jest must never touch it.
  testPathIgnorePatterns: [
    "/node_modules/",
    "<rootDir>/tests/real-obsidian/",
  ],

  // The module name mapper to resolve module paths
  moduleNameMapper: {
    "^obsidian$": "<rootDir>/src/__mocks__/obsidian.ts",
  },

  // The transform config for TypeScript files
  transform: {
    "^.+\\.tsx?$": "ts-jest",
  },

  // The coverage report config
  collectCoverage: true,
  coverageDirectory: "<rootDir>/coverage",
};
