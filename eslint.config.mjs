// @ts-check
import { builtinModules } from 'node:module';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/** Every Node built-in, bare and `node:`-prefixed. */
const NODE_BUILTINS = [
  ...new Set(builtinModules.flatMap((name) => (name.startsWith('node:') ? [name] : [name, `node:${name}`]))),
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/out/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      '**/next-env.d.ts',
      'apps/web/public/**',
      'apps/mobile/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // packages/shared and packages/fpl run in the browser AND on the server: no Node built-ins,
    // no framework imports. I/O (fetch, clock) is injected.
    files: ['packages/shared/**/*.ts', 'packages/fpl/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...NODE_BUILTINS, 'react', 'next', 'fastify', '@prisma/client'].map((name) => ({
            name,
            message: 'packages/shared and packages/fpl must stay platform-agnostic (browser + Node).',
          })),
        },
      ],
    },
  },
  {
    files: ['**/*.mjs', '**/*.cjs', '**/*.js'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', self: 'readonly', URL: 'readonly' },
    },
  },
  prettier,
);
