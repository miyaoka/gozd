// lint:fix や pre-commit hook 用の設定
// eslint.config.ts で off にしているルールを有効化する
import baseConfig from "./eslint.config";

export default [
  ...baseConfig,
  {
    rules: {
      "import-x/order": "warn",
      "better-tailwindcss/enforce-canonical-classes": "warn",
    },
  },
];
