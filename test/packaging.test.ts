import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Subpath exports must ALSO be reachable by a `node10` TypeScript resolver.
 *
 * `exports` is invisible to `moduleResolution: node10`, which looks for
 * `<pkg>/<subpath>.d.ts` on disk and nothing else. A consumer whose tsconfig says
 * `bundler` can still end up on node10 in its TEST pipeline — ts-jest compiles to
 * CommonJS, and `bundler` is invalid with `module: commonjs`, so the resolver silently
 * degrades. That is exactly how `@immediately-run/sandbox-protocol/fixtures` resolved on
 * a developer's machine and failed in the SDK's CI with `TS2307` (R3-274e1): the local
 * gate and the real gate disagreed, which `ways_of_working` §4 says to delete rather
 * than memorise.
 *
 * `typesVersions` is the shim that closes it — node10 reads it, modern resolvers ignore
 * it in favour of `exports`. This test keeps the two maps in step, because the failure
 * mode of forgetting an entry is a type error in someone ELSE's repo, days later.
 */
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as {
  exports: Record<string, string | { types?: string; default?: string }>;
  typesVersions?: Record<string, Record<string, string[]>>;
};

/** The `./x` subpaths that resolve to TYPED code (JSON and package.json excluded). */
const typedSubpaths = Object.entries(pkg.exports)
  .filter(([name, target]) => name !== '.' && typeof target === 'object' && !!target.types)
  .map(([name, target]) => ({
    name: name.replace(/^\.\//, ''),
    types: (target as { types: string }).types.replace(/^\.\//, ''),
  }));

describe('every typed subpath export is reachable under node10 resolution', () => {
  it('there are typed subpaths to check (guards the vacuous pass)', () => {
    expect(typedSubpaths.length).toBeGreaterThan(0);
  });

  it.each(typedSubpaths)('./$name has a typesVersions entry pointing at its own .d.ts', ({ name, types }) => {
    const map = pkg.typesVersions?.['*'];
    expect(map).toBeDefined();
    // Not just "an entry exists" — it must point at the SAME file `exports` names, or
    // the two maps drift and node10 consumers get a different type surface than
    // everyone else, which is worse than no entry at all.
    expect({ subpath: name, target: map?.[name] }).toEqual({ subpath: name, target: [types] });
  });

  it('typesVersions names no subpath that exports does not', () => {
    const exported = new Set(typedSubpaths.map((s) => s.name));
    for (const name of Object.keys(pkg.typesVersions?.['*'] ?? {})) {
      expect({ name, exported: exported.has(name) }).toEqual({ name, exported: true });
    }
  });

  it('every file both maps point at is actually shipped', () => {
    // `files` is `["dist","snapshots"]`; a d.ts named by either map but absent from the
    // build is a resolution error the consumer discovers, not us.
    for (const { types } of typedSubpaths) {
      expect(() => readFileSync(join(__dirname, '..', types))).not.toThrow();
    }
  });
});
