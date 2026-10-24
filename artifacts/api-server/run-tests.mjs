import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

globalThis.require = createRequire(import.meta.url);

const dir = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.resolve(dir, "src/lectureLens.test.ts")],
  platform: "node",
  bundle: true,
  format: "esm",
  outdir: path.resolve(dir, "dist"),
  outExtension: { ".js": ".mjs" },
  sourcemap: "inline",
  plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
  external: ["*.node", "pdf-parse", "pdfjs-dist", "pdfjs-dist/*"],
  banner: {
    js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
`,
  },
});

const proc = spawn("node", ["--test", path.resolve(dir, "dist/lectureLens.test.mjs")], {
  stdio: "inherit",
});

proc.on("exit", (code) => {
  process.exit(code ?? 0);
});
