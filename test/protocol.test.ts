import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as sandbox from '../src/sandbox';
import * as sdk from '../src/sdk';
import { PROTOCOL_FORMAT_VERSION, type ProtocolSnapshot } from '../src/index';

const snapshot = (side: 'sandbox' | 'sdk'): ProtocolSnapshot =>
  JSON.parse(readFileSync(join(__dirname, `../snapshots/${side}.json`), 'utf8'));

/** The wire NAMES a side's generated module declares (the `export const X = 'name'`). */
const namesOf = (mod: Record<string, unknown>): string[] =>
  Object.entries(mod)
    .filter(([k, v]) => typeof v === 'string' && k === k.toUpperCase())
    .map(([, v]) => v as string)
    .sort();

describe('each side gets its own vocabulary, not the union', () => {
  it('the module and the snapshot name exactly the same set', () => {
    // This is the property each consuming repo's gate depends on: it asserts its
    // module covers EXACTLY its own extracted wire surface, so a union module — or a
    // module that quietly gained the other side's names — would fail there, far from
    // here. Fail it here instead.
    for (const [side, mod] of [
      ['sandbox', sandbox],
      ['sdk', sdk],
    ] as const) {
      expect(namesOf(mod as unknown as Record<string, unknown>)).toEqual(
        Object.keys(snapshot(side).channels).sort(),
      );
    }
  });

  it('the two sides genuinely differ — a union would have hidden that', () => {
    const s = new Set(Object.keys(snapshot('sandbox').channels));
    const d = new Set(Object.keys(snapshot('sdk').channels));
    const sdkOnly = [...d].filter((n) => !s.has(n));
    const sandboxOnly = [...s].filter((n) => !d.has(n));
    // The SDK-only names are the ones the frame merely RELAYS (the host is the other
    // end); the sandbox-only ones are frame↔host business the SDK never sees.
    expect(sdkOnly.length).toBeGreaterThan(30);
    expect(sandboxOnly.length).toBeGreaterThan(10);
  });

  // R3-562 review · R7. `README.md` and `src/index.ts` both PUBLISH these counts in
  // prose — and `src/index.ts` ships them into `dist/index.d.ts`, so a consumer
  // downloads them. They had drifted to "57 in the SDK … 39 SDK-only" against a real
  // 70 / 52, because a number in a comment is believed by the next reader and checked
  // by nobody. This is the check.
  it('the counts the docs PUBLISH are the counts the descriptors produce', () => {
    const s = new Set(Object.keys(snapshot('sandbox').channels));
    const d = new Set(Object.keys(snapshot('sdk').channels));
    const shared = [...d].filter((n) => s.has(n)).length;
    const sdkOnly = [...d].filter((n) => !s.has(n)).length;
    // Both counts are matched as CONTIGUOUS SUBSTRINGS with their surrounding words, not
    // as bare numbers: `${sdkOnly} are SDK-only` unanchored would accept "152 are
    // SDK-only" against a real 52, which is the review's round-2 finding and is exactly
    // the kind of near-miss a drifting number produces.
    const sentence = `— ${s.size} wire names in the frame, ${d.size} in the SDK, ${shared} shared`;
    const onlyClause = `${sdkOnly} are SDK-only because the frame merely`;
    for (const rel of ['../README.md', '../src/index.ts']) {
      const text = readFileSync(join(__dirname, rel), 'utf8').replace(/\n(\/\/ |)/g, ' ').replace(/\s+/g, ' ');
      expect(text).toContain(sentence);
      expect(text).toContain(onlyClause);
      // …and the number is not merely PRESENT somewhere: nothing else may claim a
      // different SDK-only count in the same file.
      expect(text.match(/(\d+) are SDK-only/g) ?? []).toEqual([`${sdkOnly} are SDK-only`]);
    }
  });
});

// R3-562 review round 3 (BLOCKING), found independently by the SDK's own
// `check-protocol-snapshot.mjs` while wiring the consumer. The `region-visibility` sdk
// entry declared `payload.fields` and no `value` — a shape that gate's extractor cannot
// produce, so the SDK could never have matched it, and the SDK gate has no `--update`:
// the only route out is another publish, and a published version is immutable.
//
// The convention was already unanimous (17 of 18 sdk-side pushes) and unenforced. This
// is the enforcement, and it belongs HERE rather than in the SDK because this is the
// repo that can still change the answer.
describe('an sdk-side push descriptor has the shape the SDK extractor produces', () => {
  const sdkPushes = () =>
    Object.entries(snapshot('sdk').channels).filter(([, c]) => (c as { kind?: string }).kind === 'push');

  it('declares payload.reads, never payload.fields, and a value', () => {
    for (const [name, entry] of sdkPushes()) {
      const e = entry as { payload?: { reads?: string[]; fields?: unknown }; value?: unknown };
      expect({
        name,
        reads: Array.isArray(e.payload?.reads) && e.payload.reads.length > 0,
        fields: e.payload?.fields !== undefined,
        value: e.value !== undefined,
      }).toEqual({ name, reads: true, fields: false, value: true });
    }
  });

  it('covers a real population — the check would pass vacuously with no sdk pushes', () => {
    expect(sdkPushes().length).toBeGreaterThan(10);
  });
});

// R3-562 review · R3. `poll` is a hand-typed cross-reference to ANOTHER channel's name,
// and nothing resolved it: `scripts/generate.mjs` interpolates it straight into a doc
// comment, and `check:drift` round-trips a typo faithfully — so a wrong name would ship
// into `dist/sdk.d.ts` having passed the whole verify chain. Resolve it here.
describe("a channel's `poll` names a channel that exists", () => {
  it('resolves on the SAME side, for every push that declares one', () => {
    for (const side of ['sandbox', 'sdk'] as const) {
      const channels = snapshot(side).channels;
      const names = new Set(Object.keys(channels));
      for (const [name, entry] of Object.entries(channels)) {
        const poll = (entry as { poll?: string }).poll;
        if (poll === undefined) continue;
        // Existence alone is too weak: `"poll": "region-message"` names a channel that
        // exists on the same side and would ship `polled with \`region-message\`` into
        // `src/sdk.ts` (review round 2). The real invariant is the naming convention every
        // one of the 24 references already follows.
        expect({ side, name, poll }).toEqual({ side, name, poll: `request-${name}` });
        expect({ side, name, poll, resolves: names.has(poll) }).toEqual({ side, name, poll, resolves: true });
      }
    }
  });

  it('covers a real population — this would pass vacuously if nothing declared `poll`', () => {
    // The gate a cross-reference check needs most: proof it is looking at something.
    const withPoll = Object.values(snapshot('sdk').channels).filter((c) => (c as { poll?: string }).poll);
    expect(withPoll.length).toBeGreaterThan(10);
  });
});

describe('the snapshots are the contract each repo gates against', () => {
  it('both declare the format version this package documents', () => {
    for (const side of ['sandbox', 'sdk'] as const) {
      expect(snapshot(side).formatVersion).toBe(PROTOCOL_FORMAT_VERSION);
    }
  });

  it('names the package of the side it describes, so a swapped file is obvious', () => {
    expect(snapshot('sandbox').repo).toBe('sandpack-bundler');
    expect(snapshot('sdk').repo).toBe('@immediately-run/sdk');
  });

  it('every channel carries a direction and at least one site', () => {
    for (const side of ['sandbox', 'sdk'] as const) {
      for (const [name, ch] of Object.entries(snapshot(side).channels)) {
        expect(['app->host', 'host->app', 'both']).toContain(ch.direction);
        expect(ch.sites.length).toBeGreaterThan(0);
        expect(name.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('the divergences are visible, not buried', () => {
  it('there are none left (R3-274e)', () => {
    // The goal state, asserted rather than assumed — and the reason the two guards
    // below are now vacuous loops. They stay because they guard the NEXT marker
    // somebody adds, not because they are testing anything today; this case is what
    // keeps that honest, by failing the moment a marker reappears without the
    // roadmap item that justifies it.
    const marked: string[] = [];
    for (const side of ['sandbox', 'sdk'] as const) {
      for (const [name, ch] of Object.entries(snapshot(side).channels)) {
        if (ch.divergent) marked.push(`${side}:${name}`);
      }
    }
    expect(marked).toEqual([]);
  });

  it('every divergent entry explains itself', () => {
    // A marker without a note is a TODO nobody can act on: R3-274e has to know what
    // the disagreement IS to pick a shape.
    for (const side of ['sandbox', 'sdk'] as const) {
      for (const [name, ch] of Object.entries(snapshot(side).channels)) {
        if (!ch.divergent) continue;
        expect(typeof ch.divergentNote).toBe('string');
        expect((ch.divergentNote ?? '').length).toBeGreaterThan(40);
        expect(name).toBeTruthy();
      }
    }
  });

  it('a divergence is marked on BOTH sides when both speak the name', () => {
    // Marking one side only is how a resolution "completes" while the other snapshot
    // still carries the old shape.
    const s = snapshot('sandbox').channels;
    const d = snapshot('sdk').channels;
    for (const [name, ch] of Object.entries(s)) {
      if (!ch.divergent || !d[name]) continue;
      expect(d[name].divergent).toBe(true);
    }
  });
});

describe('the constants are the names, verbatim', () => {
  it('a constant never disagrees with the wire name it stands for', () => {
    // The whole point of importing a constant instead of typing a string.
    expect(sandbox.THEME).toBe('theme');
    expect(sandbox.MOUNT_ADD).toBe('mount-add');
    expect(sdk.FS_CHANGE).toBe('fs-change');
    expect(sdk.PROTOCOL_SPACES).toBe('protocol-spaces');
  });
});
