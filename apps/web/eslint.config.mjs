import shared from '../../eslint.config.shared.mjs'
import reactRefresh from 'eslint-plugin-react-refresh'

export default [
  ...shared,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-refresh': reactRefresh },
    rules: {
      // TanStack file routes export `Route`, and the UI modules intentionally
      // colocate variant helpers and Base UI aliases with their component.
      'react-refresh/only-export-components': 'off',
      // Yes-or-no questions use `confirm` from components/ui/confirm, the
      // same window as the update prompt, not the browser's own box.
      'no-restricted-globals': ['error', 'alert', 'confirm', 'prompt'],
      'no-restricted-properties': [
        'error',
        {
          message: 'Use confirm from components/ui/confirm.',
          object: 'window',
          property: 'confirm'
        },
        { message: 'Use confirm from components/ui/confirm.', object: 'window', property: 'alert' },
        { message: 'Use confirm from components/ui/confirm.', object: 'window', property: 'prompt' }
      ]
    }
  }
]
