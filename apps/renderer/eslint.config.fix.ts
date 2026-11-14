// 修正時だけ使う設定。eslint.config.ts で off にしているルールを有効化する
import baseConfig from "./eslint.config";

export default [
  ...baseConfig,
  {
    rules: {
      "import-x/order": "error",
      "better-tailwindcss/enforce-canonical-classes": "error",
    },
  },
];
