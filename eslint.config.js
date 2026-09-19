// @ts-check
import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-types/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '.continuity/**',
      '.context-mem/**',
      '.neurotrace/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'import-x': importPlugin,
    },
    rules: {
      'import-x/order': [
        'warn',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // The rule that keeps the server's MVC boundary honest (MILESTONE §2.1):
    // models/ must not import Node builtins or the transport framework.
    // Inert until apps/server/src/models/ exists in Phase 2 — see ADR 0002.
    files: ['apps/server/src/models/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'ws', 'express', 'pino'],
              message:
                'models/ must stay pure: no Node, transport or framework imports. See docs/adr/0002.',
            },
          ],
        },
      ],
    },
  },
  {
    // Root tooling config and build scripts live outside every workspace's
    // tsconfig "include", so typescript-eslint's project service has no
    // project to attach them to. They don't need type-aware rules — drop
    // to syntactic-only linting for this small set of files instead of
    // forcing them into a tsconfig they conceptually don't belong in.
    files: ['*.config.{js,mjs,ts}', '**/build.mjs', 'e2e/**/*.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      'import-x/order': 'off',
    },
  },
  prettierConfig,
);
