import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';

export default tseslint.config(
  { ignores: ['**/dist', '**/node_modules', 'llmdoc', 'coverage', '.llmdoc-tmp'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Formatting via ESLint Stylistic, matched to the existing code style.
  stylistic.configs.customize({ indent: 2, quotes: 'single', semi: true, braceStyle: '1tbs' }),
  {
    rules: {
      // This tool parses arbitrary community YAML/JSON, so `any` is unavoidable.
      '@typescript-eslint/no-explicit-any': 'off',
      // Isolated tolerant Migration sources retain compatibility with legacy inputs.
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
