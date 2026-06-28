export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/.claude/worktrees/', '/oss-export/'],
  modulePathIgnorePatterns: ['<rootDir>/dist/', '<rootDir>/.claude/worktrees/', '<rootDir>/oss-export/'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^electron-store$': '<rootDir>/src/tests/__mocks__/electron-store.js',
  },
  testMatch: ['**/tests/**/*.test.js'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: true,
    }],
  },
};
