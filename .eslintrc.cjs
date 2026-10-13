const { base, typescript } = require('./.eslintrc.base.cjs')

module.exports = {
  root: true,
  ...base,
  overrides: [
    {
      ...typescript,
      parserOptions: {
        project: './tsconfig.json',
      },
    },
  ],
  ignorePatterns: [
    'node_modules',
    '*.min.js',
    'dist',
    'build',
    // 第三方音源脚本正文，单行很长，不参与 lint
    'src/common/sources/builtin/scripts',
  ],
}
