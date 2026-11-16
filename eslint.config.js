// ESLint 10 flat config, mirroring the AveroaJS app's (airbnb-style rules on
// @eslint/js, @stylistic and eslint-plugin-import-x). Only *.js is linted; the
// hand-written *.d.ts files are checked by `npm run typecheck`.
import js from '@eslint/js';
import globals from 'globals';
import stylistic from '@stylistic/eslint-plugin';
import { flatConfigs as importX, createNodeResolver } from 'eslint-plugin-import-x';

export default [
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'storages/**',
      'test/fixtures/*/storages/**',
    ],
  },

  js.configs.recommended,
  importX.recommended,

  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    settings: {
      'import-x/resolver-next': [createNodeResolver()],
    },
    plugins: { '@stylistic': stylistic },
    rules: {
      // --- correctness / best practices (airbnb-base equivalents) ---
      'no-console': 'warn',
      // airbnb's ignoreRestSiblings: `const { omitted, ...rest } = obj` drops keys on purpose
      'no-unused-vars': ['error', { args: 'none', ignoreRestSiblings: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'object-shorthand': 'error',
      'prefer-template': 'error',
      'prefer-arrow-callback': 'error',
      'no-else-return': ['error', { allowElseIf: false }],
      'no-use-before-define': ['error', { functions: false, classes: true, variables: true }],
      'no-shadow': 'error',
      'no-param-reassign': 'error',
      'no-return-await': 'off',
      'dot-notation': 'error',
      curly: ['error', 'multi-line'],
      'no-useless-concat': 'error',
      'no-useless-return': 'error',
      radix: 'error',

      // --- imports ---
      'import-x/no-unresolved': 'error',
      // a library: runtime code may import its dependencies and peer
      // dependencies (knex, objection, edge.js, croner, @faker-js/faker), not
      // its devDependencies (tests may, see below)
      'import-x/no-extraneous-dependencies': ['error', {
        devDependencies: false, optionalDependencies: false, peerDependencies: true,
      }],
      'import-x/no-named-as-default': 'off',
      'import-x/first': 'error',
      'import-x/no-duplicates': 'error',
      'import-x/newline-after-import': 'error',

      // --- formatting (moved out of ESLint core into @stylistic) ---
      '@stylistic/indent': ['error', 2, { SwitchCase: 1 }],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
      '@stylistic/semi': ['error', 'always'],
      '@stylistic/comma-dangle': ['error', 'always-multiline'],
      // 120, not the app's 100: this codebase deliberately keeps short
      // statements (error messages, one-line guards) on one wider line
      '@stylistic/max-len': ['error', {
        code: 120,
        ignoreUrls: true,
        ignoreStrings: true,
        ignoreTemplateLiterals: true,
        ignoreRegExpLiterals: true,
      }],
      '@stylistic/object-curly-spacing': ['error', 'always'],
      '@stylistic/array-bracket-spacing': ['error', 'never'],
      '@stylistic/arrow-parens': ['error', 'always'],
      '@stylistic/arrow-spacing': 'error',
      '@stylistic/brace-style': ['error', '1tbs', { allowSingleLine: true }],
      '@stylistic/comma-spacing': 'error',
      '@stylistic/key-spacing': 'error',
      '@stylistic/keyword-spacing': 'error',
      '@stylistic/space-before-blocks': 'error',
      '@stylistic/space-infix-ops': 'error',
      '@stylistic/eol-last': 'error',
      '@stylistic/no-trailing-spaces': 'error',
      '@stylistic/no-multiple-empty-lines': ['error', { max: 1, maxEOF: 0 }],
    },
  },

  // tests and this config may import devDependencies
  {
    files: ['test/**/*.js', 'test/**/*.mjs', 'eslint.config.js'],
    rules: {
      // tests stub console.warn to assert warnings; fixture child processes report on stdout
      'no-console': 'off',
      'import-x/no-extraneous-dependencies': ['error', {
        devDependencies: true, optionalDependencies: false, peerDependencies: true,
      }],
    },
  },
];
