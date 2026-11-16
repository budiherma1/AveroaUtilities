import './setup.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

/*
 * The hand-written *.d.ts files must match the runtime: every module has one,
 * and each declares exactly the value exports (including `default`) the
 * module has at runtime. The runtime names are collected here and handed to
 * tsc in a generated file that fails to compile on any difference.
 */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NOT_PUBLISHED = new Set(['eslint.config.js']);
const modules = fs.readdirSync(root)
  .filter((f) => f.endsWith('.js') && !NOT_PUBLISHED.has(f))
  .sort();

function findTsc() {
  try {
    const pkg = createRequire(import.meta.url).resolve('typescript/package.json');
    return path.join(path.dirname(pkg), 'bin', 'tsc');
  } catch {
    return null;
  }
}

after(async () => {
  const { DB } = await import('../index.js');
  await DB.destroy();
});

test('every module has a declaration file', () => {
  const missing = modules.filter((f) => !fs.existsSync(path.join(root, f.replace(/\.js$/, '.d.ts'))));
  assert.deepEqual(missing, []);
});

test('declared value exports match the runtime exports', { timeout: 120_000 }, async (t) => {
  const tsc = findTsc();
  if (!tsc) {
    t.skip('typescript is not installed');
    return;
  }

  const lines = [];
  for (const [i, file] of modules.entries()) {
    const abs = path.join(root, file);
    const runtime = Object.keys(await import(pathToFileURL(abs).href)).sort();
    assert.ok(runtime.length > 0, `${file} has no exports`);
    const names = runtime.map((n) => JSON.stringify(n)).join(' | ');
    lines.push(
      `import * as m${i} from ${JSON.stringify(abs)};`,
      `type Runtime${i} = ${names};`,
      `type Declared${i} = keyof typeof m${i};`,
      `// ${file}: exported at runtime but not declared`,
      `export const undeclared${i}: [Exclude<Runtime${i}, Declared${i}>] extends [never] ? true : Exclude<Runtime${i}, Declared${i}> = true;`,
      `// ${file}: declared but not exported at runtime`,
      `export const phantom${i}: [Exclude<Declared${i}, Runtime${i}>] extends [never] ? true : Exclude<Declared${i}, Runtime${i}> = true;`,
    );
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'averoa-utilities-dts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'exports.mts'), `${lines.join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'es2022',
      module: 'nodenext',
      moduleResolution: 'nodenext',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      typeRoots: [path.join(root, 'node_modules', '@types')],
      types: ['node'],
    },
    files: ['exports.mts'],
  }));

  const result = spawnSync(process.execPath, [tsc, '-p', dir], { encoding: 'utf8' });
  assert.equal(result.status, 0, `declarations differ from the runtime exports:\n${result.stdout}${result.stderr}`);
});
