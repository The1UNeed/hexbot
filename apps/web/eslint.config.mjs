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
      'react-refresh/only-export-components': 'off'
    }
  }
]
