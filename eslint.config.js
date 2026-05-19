// ESLint flat config — adapted from Miles-Chat.
//
// Intent: catch correctness mistakes (unused vars, broken React hooks rules)
// without dragging a style-opinionated preset into a codebase that has its own
// conventions. tsconfig `strict: true` already catches most type-shaped issues
// — ESLint is for behavior-shaped ones.
//
// Exceptions are local `// eslint-disable-next-line <rule> -- why` with a
// rationale, NOT file- or repo-wide disables.

import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    // Files ESLint will never touch. Keep this narrow.
    ignores: ['dist/**', 'node_modules/**', 'scripts/**'],
  },
  {
    // Client — React + TS.
    files: ['src/client/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'react-hooks': reactHooks,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      // rules-of-hooks is a hard error — breaking it produces silent runtime
      // bugs, not build failures. exhaustive-deps warns: occasional intentional
      // dep omission is legitimate (e.g. mount-only effects).
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-debugger': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Server — Node, no React. console logging is legitimate here.
    files: ['src/server/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-debugger': 'error',
      'no-console': 'off',
    },
  },
  {
    // Test files — assertion libraries have legitimate reasons to use `any`.
    files: ['src/**/*.{test,spec}.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
];
