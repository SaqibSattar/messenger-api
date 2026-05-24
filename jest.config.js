/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  setupFiles: ['<rootDir>/src/tests/setup.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Default 5s is too tight for argon2-heavy auth seeding plus
  // mongodb-memory-server spin-up; 15s clearly separates genuine test
  // failures from machine-stall flakes without hiding real hangs.
  testTimeout: 15_000,
  // Without forceExit, lingering Mongoose connections from suite teardown
  // edge cases can keep Jest alive past the run.
  forceExit: true
};
