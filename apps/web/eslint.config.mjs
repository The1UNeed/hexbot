import shared from '../../eslint.config.shared.mjs'
import reactRefresh from 'eslint-plugin-react-refresh'

export default [
  ...shared,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-refresh': reactRefresh },
    rules: {
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }]
    }
  }
]
