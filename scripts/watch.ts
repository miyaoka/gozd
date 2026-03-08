import type { ChildProcess } from "node:child_process";
import type { ViteDevServer } from "vite";
import { spawn } from "node:child_process";
import path from "node:path";
import { build, createServer } from "vite";
// electron パッケージは実行時にバイナリパス（string）を返すが、
// 型定義は Electron API オブジェクトになっている（electron/electron#33412）
import electron from "electron";
const electronPath = electron as unknown as string;

const ROOT = path.resolve(import.meta.dirname, "..");

function setupMainWatcher({ resolvedUrls }: ViteDevServer) {
  process.env.VITE_DEV_SERVER_URL = resolvedUrls?.local[0];

  let electronApp: ChildProcess | null = null;
  const exitProcess = () => process.exit();

  return build({
    root: path.resolve(ROOT, "apps/electron"),
    configFile: path.resolve(ROOT, "apps/electron/vite.config.ts"),
    build: { watch: {} },
    plugins: [
      {
        name: "reload-electron",
        writeBundle() {
          if (electronApp !== null) {
            electronApp.removeListener("exit", exitProcess);
            electronApp.kill("SIGINT");
            electronApp = null;
          }

          electronApp = spawn(electronPath, ["."], {
            cwd: path.resolve(ROOT, "apps/electron"),
            env: { ...process.env, ORKIS_PROJECT_ROOT: ROOT },
          });

          electronApp.stdout?.on("data", (data: Buffer) => {
            console.log(data.toString());
          });

          electronApp.stderr?.on("data", (data: Buffer) => {
            const str = data.toString();
            const ignore = [
              "Secure coding is not enabled for restorable state",
              "CoreText note: Client requested name",
              "representedObject is not a WeakPtrToElectronMenuModelAsNSObject",
            ];
            if (ignore.some((msg) => str.includes(msg))) return;
            console.error(str);
          });

          electronApp.addListener("exit", exitProcess);
        },
      },
    ],
  });
}

function setupPreloadWatcher({ ws }: ViteDevServer) {
  return build({
    root: path.resolve(ROOT, "packages/preload"),
    configFile: path.resolve(ROOT, "packages/preload/vite.config.ts"),
    build: { watch: {} },
    plugins: [
      {
        name: "reload-preload",
        writeBundle() {
          ws.send({ type: "full-reload" });
        },
      },
    ],
  });
}

const rendererServer = await createServer({
  root: path.resolve(ROOT, "apps/renderer"),
  configFile: path.resolve(ROOT, "apps/renderer/vite.config.ts"),
}).then((s) => s.listen());

await setupPreloadWatcher(rendererServer);
await setupMainWatcher(rendererServer);
