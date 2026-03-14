import { rm } from "node:fs/promises";
import { join } from "node:path";

const distDir = join(import.meta.dirname, "dist");
await rm(distDir, { recursive: true, force: true });

const commandsDir = join(import.meta.dirname, "src/commands");
const glob = new Bun.Glob("*[!d].ts");
const commandEntrypoints = Array.from(glob.scanSync(commandsDir)).map((f) => join(commandsDir, f));

const result = await Bun.build({
  entrypoints: [join(import.meta.dirname, "src/index.ts"), ...commandEntrypoints],
  outdir: distDir,
  target: "bun",
  format: "esm",
});

if (!result.success) {
  console.error("CLI build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}
