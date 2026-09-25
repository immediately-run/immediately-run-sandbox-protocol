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

// R3-620 review (BLOCKING) — the same "the SDK extractor cannot produce it" class, but via
// ORDER rather than shape. Each consumer's `check-protocol-snapshot.mjs` sorts every
// fingerprinted field list by `name.localeCompare` and compares order-sensitively against the
// published snapshot with no `--update`, so a descriptor whose field list is not name-sorted
// (here, `modelHint` before `model`, `providerId` before `model`) can never match — and an
// immutable publish strands the consumer's `protocol:check` behind a corrective re-publish.
// `verify:drift` round-trips field order faithfully (only wire NAMES are sorted), so this
// repo's own gate would not catch it. The defect class exists on BOTH sides (sdk and sandbox
// snapshots each feed an order-sensitive consumer gate), so the walk is over both, and it is
// enforced here — the one repo that can still change the answer.
describe('every field list is name-sorted as the extractor emits', () => {
  const isFieldList = (a: unknown): a is { name: string }[] =>
    Array.isArray(a) && a.length > 0 && a.every((e) => e && typeof e === 'object' && typeof (e as { name?: unknown }).name === 'string');

  const assertFieldsSorted = (node: unknown, path: string): void => {
    if (isFieldList(node)) {
      const names = node.map((f) => f.name);
      const sorted = [...names].sort((a, b) => a.localeCompare(b));
      if (names.some((n, i) => i > 0 && n.localeCompare(names[i - 1]) < 0)) {
        throw new Error(`${path}: field list not name-sorted — got [${names.join(', ')}], want [${sorted.join(', ')}]`);
      }
    }
    if (Array.isArray(node)) {
      for (const item of node) assertFieldsSorted(item, `${path}[]`);
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) assertFieldsSorted(v, `${path}.${k}`);
    }
  };

  it('walks every payload at every nesting level and requires name order', () => {
    for (const side of ['sandbox', 'sdk'] as const) {
      for (const [name, entry] of Object.entries(snapshot(side).channels)) {
        assertFieldsSorted(entry, `${side}.channels.${name}`);
      }
    }
  });

  it('covers a real population of field lists', () => {
    let lists = 0;
    const count = (node: unknown): void => {
      if (isFieldList(node)) lists += 1;
      if (Array.isArray(node)) node.forEach(count);
      else if (node && typeof node === 'object') Object.values(node).forEach(count);
    };
    for (const side of ['sandbox', 'sdk'] as const) Object.values(snapshot(side).channels).forEach(count);
    expect(lists).toBeGreaterThan(20);
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

// R3-620 review (BLOCKING) — the extractor that fingerprints a push channel's `value`
// (immediately-run-sdk/scripts/check-protocol-snapshot.mjs) starts at depth 1 with
// MAX_DEPTH=2. A UNION value consumes one depth level: its object members sit at depth 2 and
// their FIELDS at depth 3, where the extractor can only emit a flat `{type}` — an inline
// `fields`/`array`/`union` there is a shape the consumer can never produce, stranding the
// SDK's `protocol:check` behind a corrective re-publish (the same class the field-order gate
// records). A NON-union value's fields land at depth 2 and MAY be structured (e.g.
// `fs-change.paths` is `{array:{type:"string"}}`), so the rule — and this walk — is scoped to
// union-member fields only.
describe('a union-valued push channel\'s fields are flat type references the extractor can produce', () => {
  let sawUnionMemberFields = false;

  it('no union-member value field inlines a shape the depth-2 extractor flattens', () => {
    for (const [name, entryRaw] of Object.entries(snapshot('sdk').channels)) {
      const entry = entryRaw as {
        kind?: string;
        value?: { union?: { fields?: { name: string; type?: unknown; fields?: unknown; array?: unknown; union?: unknown }[] }[] };
      };
      if (entry.kind !== 'push') continue;
      let inspected = 0;
      for (const member of entry.value?.union ?? []) {
        for (const f of member.fields ?? []) {
          inspected += 1;
          const nested = f.fields !== undefined || f.array !== undefined || f.union !== undefined;
          if (nested) {
            throw new Error(`${name}: value field ${f.name} is an inline shape, not a flat type reference`);
          }
          if (typeof f.type !== 'string') {
            throw new Error(`${name}: value field ${f.name} has no flat type`);
          }
        }
      }
      if (inspected > 0) sawUnionMemberFields = true;
    }
  });

  it('covers a real population of union-member fields', () => {
    expect(sawUnionMemberFields).toBe(true);
  });
});

// R3-708 review round 1 (BLOCKING ×2) — the same "a shape the SDK extractor cannot produce"
// class as R3-562 and R3-620, reached through the REQUEST side, which none of the rules above
// walked. `npm run verify` was green on a wire the consumer rejected, twice, and only an
// overlay experiment in the SDK checkout found it. Each would have cost a corrective publish,
// because the consumer's gate has no `--update` and a published version is immutable.
//
// Enforced here for the reason the two notes above give: this is the repo that can still
// change the answer.
describe('a request/stream method payload is a shape the SDK extractor produces', () => {
  const sdkMethodPayloads = (): [string, string, Record<string, unknown>][] => {
    const out: [string, string, Record<string, unknown>][] = [];
    for (const [name, entryRaw] of Object.entries(snapshot('sdk').channels)) {
      const entry = entryRaw as { kind?: string; methods?: Record<string, { payload?: Record<string, unknown> }> };
      if (entry.kind !== 'request' && entry.kind !== 'stream') continue;
      for (const [method, spec] of Object.entries(entry.methods ?? {})) {
        if (spec.payload) out.push([name, method, spec.payload]);
      }
    }
    return out;
  };

  // The extractor renders every literal through TypeScript's own `typeToString`, which
  // double-quotes. A single-quoted literal in a descriptor is unmatchable — and invisible,
  // because both spellings read identically to a human.
  const assertLiteralQuoting = (node: unknown, path: string): void => {
    if (node && typeof node === 'object') {
      const t = (node as { type?: unknown }).type;
      if (typeof t === 'string' && /(^|[|\s(])'/.test(t)) {
        throw new Error(`${path}: literal type ${t} is single-quoted; the extractor emits double quotes`);
      }
      for (const [k, v] of Object.entries(node)) assertLiteralQuoting(v, `${path}.${k}`);
    } else if (Array.isArray(node)) {
      node.forEach((v, i) => assertLiteralQuoting(v, `${path}[${i}]`));
    }
  };

  it('uses double-quoted literal types, as TypeScript renders them', () => {
    for (const [name, method, payload] of sdkMethodPayloads()) {
      assertLiteralQuoting(payload, `${name}.${method}.payload`);
    }
  });

  // `describeType` sorts union members by `JSON.stringify` and the consumer compares
  // order-sensitively. The field-order rule above cannot see this: its `isFieldList` requires
  // a `name` on every element, and union members have none.
  const assertUnionsSorted = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => assertUnionsSorted(v, `${path}[${i}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    const union = (node as { union?: unknown }).union;
    if (Array.isArray(union)) {
      const keys = union.map((m) => JSON.stringify(m));
      const sorted = [...keys].sort();
      if (keys.some((k, i) => i > 0 && k < keys[i - 1])) {
        throw new Error(`${path}: union members not sorted — got ${keys.join(' | ')}, want ${sorted.join(' | ')}`);
      }
    }
    for (const [k, v] of Object.entries(node)) assertUnionsSorted(v, `${path}.${k}`);
  };

  it('sorts union members the way the extractor does', () => {
    for (const [name, method, payload] of sdkMethodPayloads()) {
      assertUnionsSorted(payload, `${name}.${method}.payload`);
    }
  });

  it('covers a real population of request payloads', () => {
    expect(sdkMethodPayloads().length).toBeGreaterThan(5);
  });
});

// The second blocking finding, and the cheapest of all of these to assert: the family's
// scheme list is DERIVABLE from the channels, so it can never be a second thing to remember.
// Adding `protocol-spaces-mode` without adding `spaces-mode` here produced a divergence the
// consumer reported as `~ (dynamic families)` and this repo reported as nothing at all.
describe('the protocol-<scheme> family lists exactly the sdk request/stream schemes', () => {
  it('is derived, not maintained', () => {
    const channels = snapshot('sdk').channels as Record<string, { kind?: string }>;
    const derived = Object.entries(channels)
      .filter(([n, c]) => (c.kind === 'request' || c.kind === 'stream') && n.startsWith('protocol-'))
      .map(([n]) => n.slice('protocol-'.length))
      .sort();
    const declared = ((snapshot('sdk').dynamicFamilies ?? {}) as Record<string, { schemes?: string[] }>)[
      'protocol-<scheme>'
    ]?.schemes;
    expect(declared).toEqual(derived);
  });
});
