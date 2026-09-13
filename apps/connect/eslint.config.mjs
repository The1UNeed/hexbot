import shared from '../../eslint.config.shared.mjs'

export default [
  ...shared,
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      curly: 'off',
      'padding-line-between-statements': 'off',
      'perfectionist/sort-exports': 'off',
      'perfectionist/sort-imports': 'off',
      'perfectionist/sort-jsx-props': 'off',
      'perfectionist/sort-named-exports': 'off',
      'perfectionist/sort-named-imports': 'off'
    }
  }
]
