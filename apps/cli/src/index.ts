#!/usr/bin/env bun

import { join } from "node:path";
import { createCLI } from "@miyaoka/fsss";

const { version } = await import("../../../package.json");

const cli = createCLI({
  name: "orkis",
  commandsDir: join(import.meta.dirname, "commands"),
  defaultCommand: "open",
  version,
});
await cli.run();
