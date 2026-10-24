import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const apiRequire = createRequire(new URL('../api-server/package.json', import.meta.url));
const { build } = apiRequire('esbuild');
const outputDir = mkdtempSync(path.join(tmpdir(), 'lecturelens-pomodoro-'));
const testFiles = ['pomodoro.test.mjs', 'theme.test.mjs'];

try {
  await build({
    entryPoints: [
      path.join(projectDir, 'src/lib/pomodoro.test.ts'),
      path.join(projectDir, 'src/lib/theme.test.ts'),
    ],
    platform: 'node',
    bundle: true,
    format: 'esm',
    outdir: outputDir,
    outExtension: { '.js': '.mjs' },
  });
  const result = spawnSync(process.execPath, ['--test', ...testFiles.map((file) => path.join(outputDir, file))], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}
