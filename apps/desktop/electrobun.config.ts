import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "orkis",
    identifier: "com.miyaoka.orkis",
    version: "0.0.0",
    description: "AI Agent Orchestrator",
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
      "node_modules/@orkis/renderer/dist/": "views/main/",
      "node_modules/@orkis/cli/dist/": "cli/",
      "node_modules/@orkis/cli/bin/": "bin/",
      "zsh/": "zsh/",
    },
  },
  runtime: {
    exitOnLastWindowClosed: true,
  },
} satisfies ElectrobunConfig;
