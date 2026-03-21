import type { ElectrobunConfig } from "electrobun";

const isDev = "GOZD_DEV_PROJECT_ROOT" in process.env;

export default {
  app: {
    name: "gozd",
    identifier: "com.miyaoka.gozd",
    version: "0.0.0",
    description: "Git Orchestrated Zone for Development",
  },
  build: {
    bun: {
      entrypoint: "src/index.ts",
    },
    views: {
      main: {
        entrypoint: "src/placeholder.ts",
      },
    },
    copy: {
      // renderer/cli の dist/ は pnpm build でのみ生成される
      ...(isDev
        ? {}
        : {
            "node_modules/@gozd/renderer/dist/": "views/main/",
            "node_modules/@gozd/cli/dist/": "cli/",
          }),
      "node_modules/@gozd/cli/bin/": "bin/",
      "zsh/": "zsh/",
    },
  },
  runtime: {
    exitOnLastWindowClosed: true,
  },
} satisfies ElectrobunConfig;
