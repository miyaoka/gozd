#!/usr/bin/env bun

import { join } from "node:path";
import { createCLI } from "@miyaoka/fsss";

const cli = createCLI({
  name: "orkis",
  commandsDir: join(import.meta.dirname, "commands"),
  defaultCommand: "open",
});
await cli.run();
