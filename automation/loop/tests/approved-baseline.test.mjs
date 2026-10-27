import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ROOT } from '../src/config.mjs';
import { join } from 'node:path';

const json = async file => JSON.parse(await readFile(join(ROOT, file), 'utf8'));
test('approved Node >=24 and pnpm 12 baseline', async () => {
  const root = await json('package.json');
  assert.equal(root.engines.node, '>=24');
  assert.equal(root.packageManager, 'pnpm@12.15.0');
});
test('frontend versions are exact and Rust uses 2024 edition', async () => {
  const desktop = await json('apps/desktop/package.json');
  for (const [key, version] of Object.entries({...desktop.dependencies, ...desktop.devDependencies})) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${key} must be pinned`);
  }
  assert.equal(desktop.dependencies.vue, '3.5.44');
  assert.equal(desktop.devDependencies.vite,'8.3.5');
  assert.equal(desktop.devDependencies.typescript,'6.0.3');
  const rust = await readFile(join(ROOT, 'rust-toolchain.toml'),'utf8');
  assert.match(rust,/channel\s*=\s*"1\.99\.1"/);
});
