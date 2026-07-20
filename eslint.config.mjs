import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['dist/**'],
  },
  js.configs.recommended,
  {
    rules: {
      // Control-character ranges intentionally remove invalid filename bytes.
      'no-control-regex': 'off',
      'no-unused-vars': ['error', {
        caughtErrors: 'none',
        // Fidelity's API adapter keeps these shared-core handles/constants
        // together while its live-calibration implementation is still underway.
        varsIgnorePattern: '^(CUSTOMER_FOLDER|normalizeDocument|sleep)$',
      }],
    },
  },
  {
    files: ['background.js', 'content.js', 'core/**/*.js', 'providers/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
    },
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node,
    },
  },
];
