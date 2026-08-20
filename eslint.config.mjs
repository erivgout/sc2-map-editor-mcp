// @ts-check
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  // `scratch/` is an untracked bench for driving the server by hand; it is not shipped
  // code and is deliberately outside the TypeScript projects.
  globalIgnores(['**/dist/**', '**/node_modules/**', 'vendor/**', 'native/**', 'fixtures/generated/**', 'coverage/**', 'scratch/**']),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Root-level config files are not part of any tsconfig `include`, but they
          // still deserve linting.
          allowDefaultProject: ['eslint.config.mjs', 'scripts/gauntlet-acceptance.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The MCP boundary hands us `unknown`; narrowing is the whole point of the
      // domain layer, so an explicit cast at a validated edge is legitimate.
      '@typescript-eslint/no-unnecessary-condition': 'off',

      // Sizes, counts, byte offsets, and revisions belong in diagnostic strings.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],

      // `noUncheckedIndexedAccess` makes bracket access on index signatures
      // (`process.env['X']`, `Record<string, unknown>`) the type-safe form, which this
      // rule would otherwise fight.
      '@typescript-eslint/dot-notation': ['error', { allowIndexSignaturePropertyAccess: true }],

      // Empty callbacks here are deliberate: swallowing a cleanup failure that must not
      // mask the original error, and the null logger's discard sink. Each is commented
      // at its site.
      '@typescript-eslint/no-empty-function': ['error', { allow: ['arrowFunctions', 'methods'] }],

      // stdout is the MCP protocol wire on a stdio connection (PLAN.md §55 rule 12).
      // Logging goes through the structured logger to stderr; `console` is never right
      // in library or tool code.
      'no-console': 'error',

      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
  {
    files: ['**/*.test.ts', 'tests/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      'no-console': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/explicit-function-return-type': 'off',
      'no-console': 'off',
    },
  },
]);
