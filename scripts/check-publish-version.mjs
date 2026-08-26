#!/usr/bin/env node
// check-publish-version.mjs — CHECK 2 of roadmap R3-327: a PR that changes shipped
// bytes must bump `version` in the SAME PR.
//
// THE FAILURE THIS EXISTS FOR. `sdk #111` changed `src/linkSpace.ts` and did not bump
// `version`. The release job on `main` refused, correctly:
//
//     Immutability violation: the integrity trust root for already-published
//     version(s) [0.45.3] would change. A published SDK version is immutable.
//
// The immutability gate is a GOOD gate. Its only flaw is that it runs AFTER merge, so
// the cost lands on `main` and on whoever pushes next — and the release job is
// `if: github.event_name == 'push'`, so a PR never runs it at all. (`sdk #112`'s
// unrelated bump to `0.46.0` is what incidentally cleared it; nobody fixed it
// deliberately, which is its own argument for this check.) The repo's convention was
// explicit — `5b9c79f Release 0.45.1 — bump in the PR that changes shipped bytes` — and
// lived only in a commit message. Prose does not gate merges.
//
// So: same question, moved to PR time. One `npm view <pkg> versions` call.
//
// SCOPED TO WHAT ACTUALLY SHIPS. The trigger is the tarball globs (`files:` in
// package.json) plus the sources they are built from, MINUS tests, docs, CI config and
// tooling. A PR that changes only tests or docs demands no bump — that is asserted by a
// case below, not by inspection.
//
// The `[skip ci]` trust-root commits release CI pushes after a publish are NOT a special
// case and must not be one: they touch `integrity/`, which is not in the tarball scope,
// so they do not match. Do not special-case by author — an author allowlist is a hole
// somebody eventually walks a real change through.
//
// AN UNREACHABLE REGISTRY, OR AN UNKNOWN BASE, IS A THIRD OUTCOME. "not published" and
// "could not tell" are different answers; a check that silently treats the second as the
// first is worse than no check. Both fail in CI, with the reason attached.
//
// Copied, not shared — see check-dependency-pins.mjs for why.
//
// Run: `node scripts/check-publish-version.mjs`
//      `node scripts/check-publish-version.mjs --base <ref>`  (replay against a base)
//      `node scripts/check-publish-version.mjs --self-test`   (prove it can fail)

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * Paths that never reach the tarball even when they sit under a shipped directory.
 * This list is the whole of exit criterion 3: a PR that changes only tests, docs or CI
 * config must pass.
 */
const NEVER_SHIPPED = [
  /(^|\/)__tests__\//,
  /(^|\/)__fixtures__\//,
  /(^|\/)(test|tests|e2e)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /^\.github\//,
  /^scripts\//,
  /^docs?\//,
  /^integrity\//,
  /\.md$/,
  /^\.[^/]+$/, // dotfiles at the root (.gitignore, .prettierrc, …)
  /^(package-lock\.json|api-snapshot\.json)$/,
];

/**
 * Directories whose contents reach the published tarball. `files:` names what npm packs
 * (usually the BUILT output); `src/` is where those bytes come from, and it is what a PR
 * actually edits — checking only `files:` would miss every real case, since `dist/` is
 * generated and gitignored.
 */
export function shippedScope(pkg, extra = ['src']) {
  const globs = Array.isArray(pkg.files) ? pkg.files : [];
  return [...new Set([...globs.map((g) => g.replace(/^\.\//, '').replace(/\/?\*+$/, '')), ...extra])].filter(Boolean);
}

/** Does `path` reach the published tarball? */
export function isShipped(path, scope) {
  if (NEVER_SHIPPED.some((re) => re.test(path))) return false;
  return scope.some((dir) => path === dir || path.startsWith(`${dir}/`));
}

/** Next patch above the highest published version, as a concrete suggestion. */
export function nextVersion(versions) {
  const parsed = versions
    .map((v) => /^(\d+)\.(\d+)\.(\d+)$/.exec(v))
    .filter(Boolean)
    .map((m) => [Number(m[1]), Number(m[2]), Number(m[3])])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  if (parsed.length === 0) return null;
  const [maj, min, pat] = parsed[parsed.length - 1];
  return `${maj}.${min}.${pat + 1}`;
}

/**
 * The pure checker. `registry` is:
 *   `{ ok: true, versions: string[] }`
 *   `{ ok: false, kind: 'not-found' }`            — never published; nothing to violate
 *   `{ ok: false, kind: 'undetermined', detail }` — could not tell → FAIL
 * `changedFiles` is `null` when the base ref could not be resolved → FAIL.
 */
export function checkPublishVersion({ pkg, changedFiles, registry }) {
  const errors = [];
  const notes = [];
  const scope = shippedScope(pkg);

  if (changedFiles === null) {
    errors.push(
      'Could not determine which files this branch changes (no base ref).\n' +
        '   This is not a pass — without a diff the check has no opinion, and a check with no\n' +
        '   opinion must not report success.',
    );
    return { errors, notes, shipped: [] };
  }

  const shipped = changedFiles.filter((f) => isShipped(f, scope));
  if (shipped.length === 0) {
    notes.push(`No shipped bytes changed (scope: ${scope.join(', ')}) — no version bump required.`);
    return { errors, notes, shipped };
  }

  if (!registry) {
    errors.push('Shipped bytes changed but the registry was not consulted — refusing to report success.');
    return { errors, notes, shipped };
  }
  if (!registry.ok) {
    if (registry.kind === 'not-found') {
      notes.push(`${pkg.name} has never been published — nothing to violate yet.`);
      return { errors, notes, shipped };
    }
    errors.push(
      `Shipped bytes changed and the published version list could NOT be determined ` +
        `(${registry.detail ?? 'registry error'}).\n   This is not a pass. Re-run when the registry is reachable.`,
    );
    return { errors, notes, shipped };
  }

  if (!registry.versions.includes(pkg.version)) {
    notes.push(`${pkg.name}@${pkg.version} is unpublished — the bump is present.`);
    return { errors, notes, shipped };
  }

  const next = nextVersion(registry.versions);
  errors.push(
    `${pkg.name}@${pkg.version} is ALREADY PUBLISHED, and this branch changes bytes that ship:\n` +
      `     ${shipped.slice(0, 8).join('\n     ')}${
        shipped.length > 8 ? `\n     …and ${shipped.length - 8} more` : ''
      }\n` +
      `   A published version is immutable. Bump \`version\` in package.json IN THIS PR` +
      (next ? ` — \`${next}\` is the next free patch` : '') +
      `,\n   then run \`npm install\` so the lockfile's own version field follows.\n` +
      `   Caught here rather than by the release job on \`main\`, which is where this cost\n` +
      `   used to land (R3-327).`,
  );
  return { errors, notes, shipped };
}

// ── I/O ──────────────────────────────────────────────────────────────────────

/** The files this branch changes vs its merge base, or `null` if undecidable. */
function changedFilesVsBase() {
  // `--base <ref>` exists so a historical PR can be REPLAYED through this exact code
  // path rather than only through the pure checker — the difference between "the logic
  // is right" and "the plumbing that feeds it is right", which is where a check of this
  // shape usually breaks.
  const flag = process.argv.indexOf('--base');
  const base =
    flag >= 0 && process.argv[flag + 1]
      ? process.argv[flag + 1]
      : process.env.GITHUB_BASE_REF
      ? `origin/${process.env.GITHUB_BASE_REF}`
      : 'origin/main';
  const run = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    // `A...B` is the three-dot diff: what B changed since the branches diverged, which
    // is the PR's own contribution and not everything that landed on main meanwhile.
    const out = run(['diff', '--name-only', `${base}...HEAD`]);
    return out.split('\n').filter(Boolean);
  } catch {
    try {
      run(['fetch', '--no-tags', '--depth=50', 'origin', process.env.GITHUB_BASE_REF || 'main']);
      const out = run(['diff', '--name-only', `${base}...HEAD`]);
      return out.split('\n').filter(Boolean);
    } catch {
      return null;
    }
  }
}

function fetchVersions(name) {
  try {
    const out = execFileSync('npm', ['view', name, 'versions', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    });
    const parsed = JSON.parse(out);
    return { ok: true, versions: Array.isArray(parsed) ? parsed : [parsed] };
  } catch (err) {
    const text = `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`;
    if (/E404|is not in this registry|404 Not Found/i.test(text)) return { ok: false, kind: 'not-found' };
    return { ok: false, kind: 'undetermined', detail: text.trim().split('\n')[0]?.slice(0, 160) };
  }
}

// ── self-test: prove the gate can actually fail ──────────────────────────────
if (process.argv.includes('--self-test')) {
  let failures = 0;
  const PKG = { name: '@immediately-run/sdk', version: '0.45.3', files: ['dist'] };
  const PUBLISHED = { ok: true, versions: ['0.45.0', '0.45.1', '0.45.2', '0.45.3'] };
  const fails = (label, got, matcher) => {
    const joined = got.errors.join('\n');
    if (!matcher.test(joined)) {
      console.error(`SELF-TEST FAIL: ${label}\n  got: ${joined || '(no errors)'}`);
      failures++;
    } else console.log(`  ok  ${label}`);
  };
  const passes = (label, got) => {
    if (got.errors.length) {
      console.error(`SELF-TEST FAIL: ${label}\n  got: ${got.errors.join('\n')}`);
      failures++;
    } else console.log(`  ok  ${label}`);
  };

  // 1. THE sdk #111 REPLAY — its exact file list, and the version it actually carried.
  const r111 = checkPublishVersion({
    pkg: PKG,
    changedFiles: ['src/linkSpace.test.ts', 'src/linkSpace.ts'],
    registry: PUBLISHED,
  });
  fails("sdk #111's diff fails check 2", r111, /ALREADY PUBLISHED/);
  fails('…and names the version to bump to', r111, /`0\.45\.4` is the next free patch/);
  fails('…and names the offending file, not just the fact', r111, /src\/linkSpace\.ts/);

  // 2. exit criterion 3 — tests / docs / CI alone demand NO bump. This is the case that
  //    decides whether the check is livable; asserted, not inspected.
  passes(
    'a tests-only PR passes',
    checkPublishVersion({ pkg: PKG, changedFiles: ['src/linkSpace.test.ts'], registry: PUBLISHED }),
  );
  passes(
    'a docs/CI/tooling-only PR passes',
    checkPublishVersion({
      pkg: PKG,
      changedFiles: ['README.md', '.github/workflows/ci.yml', 'scripts/check-circular.mjs', 'docs/index.html'],
      registry: PUBLISHED,
    }),
  );
  passes(
    'the [skip ci] trust-root commit shape passes — it touches integrity/, not the tarball',
    checkPublishVersion({
      pkg: PKG,
      changedFiles: ['integrity/v0.45.3/integrity.json'],
      registry: PUBLISHED,
    }),
  );

  // 3. the bump present → pass (this is sdk #112, which changed src AND bumped)
  passes(
    'shipped bytes WITH a bump passes',
    checkPublishVersion({
      pkg: { ...PKG, version: '0.46.0' },
      changedFiles: ['src/hostAttention.ts'],
      registry: PUBLISHED,
    }),
  );

  // 4. undetermined answers FAIL — neither is "fine"
  fails(
    'an unreachable registry fails rather than passing',
    checkPublishVersion({
      pkg: PKG,
      changedFiles: ['src/linkSpace.ts'],
      registry: { ok: false, kind: 'undetermined', detail: 'ETIMEDOUT' },
    }),
    /could NOT be determined/,
  );
  fails(
    'an unresolvable base ref fails rather than passing',
    checkPublishVersion({ pkg: PKG, changedFiles: null, registry: PUBLISHED }),
    /no base ref/,
  );

  // 5. a never-published package is not a violation
  passes(
    'a package that has never been published passes',
    checkPublishVersion({
      pkg: { ...PKG, name: '@immediately-run/brand-new' },
      changedFiles: ['src/a.ts'],
      registry: { ok: false, kind: 'not-found' },
    }),
  );

  // 6. the scope follows `files:`, not a hard-coded list — a repo packing `lib/`
  //    must be covered without editing this script.
  fails(
    "the shipped scope follows the package's own `files:` globs",
    checkPublishVersion({
      pkg: { ...PKG, files: ['lib'] },
      changedFiles: ['lib/index.js'],
      registry: PUBLISHED,
    }),
    /ALREADY PUBLISHED/,
  );

  if (failures) {
    console.error(`\n${failures} self-test case(s) failed.`);
    process.exit(1);
  }
  console.log('11/11 self-test cases.');
  process.exit(0);
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const changedFiles = changedFilesVsBase();
// Only ask the registry when something shipped actually changed — a docs-only PR should
// not spend a network round trip, and the ~10s budget is per PR, not per check.
const needsRegistry = changedFiles !== null && changedFiles.some((f) => isShipped(f, shippedScope(pkg)));
const registry = needsRegistry ? fetchVersions(pkg.name) : { ok: true, versions: [] };

const { errors, notes, shipped } = checkPublishVersion({ pkg, changedFiles, registry });
for (const n of notes) console.log(`note: ${n}`);
if (errors.length) {
  console.error('\npublish-version check FAILED:\n');
  for (const e of errors) console.error(` - ${e}\n`);
  process.exit(1);
}
console.log(
  shipped.length === 0
    ? `OK: no shipped bytes changed — ${pkg.name}@${pkg.version} needs no bump.`
    : `OK: ${shipped.length} shipped file(s) changed and ${pkg.name}@${pkg.version} is unpublished — the bump is present.`,
);
