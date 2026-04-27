/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Provide required env vars so config.ts doesn't throw on import
  setupFiles: ['<rootDir>/__tests__/setup.ts'],
  // Increase timeout for performance tests
  testTimeout: 15000,
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: 'tsconfig.test.json',
    }],
    // Transform ESM-only packages (p-limit, yocto-queue) to CJS for Jest
    '^.+\\.js$': ['ts-jest', {
      tsconfig: 'tsconfig.test.json',
      useESM: false,
    }],
  },
  // Allow Jest to transform ESM-only node_modules (p-limit, yocto-queue, etc.)
  transformIgnorePatterns: [
    'node_modules/(?!(p-limit|yocto-queue)/)',
  ],
};
