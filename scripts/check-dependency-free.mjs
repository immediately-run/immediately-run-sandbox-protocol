#!/usr/bin/env node
/*
 * This package must stay DEPENDENCY-FREE (PLATFORM_LAYERING_SPEC §3 / S2, R3-275).
 *
 * Both sides of the sandbox↔SDK seam depend on it and it depends on neither, which
 * is the whole reason a shared vocabulary can live here at all. A runtime dependency
 * added here is inherited by every consumer — including the sandbox bundle, which
 * ships to the browser — and by anything that later consumes it. The rule is easy to
 * state and easy to break in a PR that "just needs one small helper", so it is
 * asserted rather than remembered.
 *
 * Run: node scripts/check-dependency-free.mjs [--self-test]
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Fields that put a package into a CONSUMER's install graph. `devDependencies` do
 *  not — they are this repo's own toolchain and never ship (`files: ["dist"]`). */
const RUNTIME_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];

const check = (pkg) => {
  const found = [];
  for (const field of RUNTIME_FIELDS) {
    for (const name of Object.keys(pkg[field] ?? {})) found.push(`${field}: ${name}`);
  }
  return found;
};

const selfTest = () => {
  const cases = [
    ['a runtime dependency', { dependencies: { lodash: '^4' } }],
    ['a peer dependency', { peerDependencies: { react: '^19' } }],
    ['an optional dependency', { optionalDependencies: { fsevents: '*' } }],
  ];
  let ok = 0;
  for (const [label, pkg] of cases) {
    const caught = check(pkg).length > 0;
    console.log(`${caught ? 'PASS' : 'FAIL'}  detects: ${label}`);
    if (caught) ok++;
  }
  const devOk = check({ devDependencies: { jest: '^29' } }).length === 0;
  console.log(`${devOk ? 'PASS' : 'FAIL'}  devDependencies do not count (they never ship)`);
  if (devOk) ok++;
  const total = cases.length + 1;
  console.log(`\n${ok}/${total} self-test cases.`);
  if (ok !== total) process.exit(1);
};

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const found = check(pkg);
  if (found.length) {
    console.error('✗ this package must stay dependency-free, but declares:\n');
    for (const f of found) console.error(`  - ${f}`);
    console.error(
      '\nBoth sides of the sandbox<->SDK seam depend on this package and it depends on\n' +
        'neither — that is what makes it a safe home for shared vocabulary. Inline the\n' +
        'helper, or the dependency ships to every consumer including the browser bundle.',
    );
    process.exit(1);
  }
  console.log('PASS  dependency-free (no runtime, peer, or optional dependencies).');
}
