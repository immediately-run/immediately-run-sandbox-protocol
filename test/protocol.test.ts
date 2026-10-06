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
describe('every declared shape is one the extractor can produce', () => {
  // Round 2 caught the first version of these walking `entry.methods` only, so a PUSH
  // channel's `value` union — including the one this very change adds — was unguarded:
  // swapping `spaces-mode.value.union`'s members passed every test here and produced
  // `~ spaces-mode` in the consumer. So they walk WHOLE CHANNELS on BOTH sides, the way
  // the R3-620 field-order rule directly above already does.
  const everyChannel = (): [string, unknown][] =>
    (['sandbox', 'sdk'] as const).flatMap((side) =>
      Object.entries(snapshot(side).channels).map(([n, c]) => [`${side}:${n}`, c] as [string, unknown]),
    );

  // The extractor renders every literal through TypeScript's `typeToString`, which
  // DOUBLE-quotes. A single-quoted literal is unmatchable — and invisible, because both
  // spellings read identically to a human.
  //
  // Checked by stripping double-quoted spans and rejecting any quote left over, rather
  // than by matching the positions a literal can start at: round 2 showed the positional
  // form missed `Array<'a'>`, `Record<string,'a'>`, `['a','b']` and `{x:'a'}`. Stripping
  // first keeps the one legitimate apostrophe case ("it's") passing.
  const assertLiteralQuoting = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => assertLiteralQuoting(v, `${path}[${i}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    const t = (node as { type?: unknown }).type;
    if (typeof t === 'string' && t.replace(/"(?:[^"\\]|\\.)*"/g, '').includes("'")) {
      throw new Error(`${path}: literal type ${t} is single-quoted; the extractor emits double quotes`);
    }
    for (const [k, v] of Object.entries(node)) assertLiteralQuoting(v, `${path}.${k}`);
  };

  // `describeType` sorts union members by `JSON.stringify` and the consumer compares
  // order-sensitively. The field-order rule cannot see this: its `isFieldList` requires a
  // `name` on every element, and union members have none.
  const assertUnionsSorted = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => assertUnionsSorted(v, `${path}[${i}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    const union = (node as { union?: unknown }).union;
    if (Array.isArray(union)) {
      const keys = union.map((m) => JSON.stringify(m));
      if (keys.some((k, i) => i > 0 && k < keys[i - 1])) {
        throw new Error(
          `${path}: union members not sorted — got ${keys.join(' | ')}, want ${[...keys].sort().join(' | ')}`,
        );
      }
    }
    for (const [k, v] of Object.entries(node)) assertUnionsSorted(v, `${path}.${k}`);
  };

  it('uses double-quoted literal types, as TypeScript renders them', () => {
    for (const [name, channel] of everyChannel()) assertLiteralQuoting(channel, name);
  });

  it('sorts union members the way the extractor does', () => {
    for (const [name, channel] of everyChannel()) assertUnionsSorted(channel, name);
  });

  it('covers a real population — both sides, every channel', () => {
    expect(everyChannel().length).toBeGreaterThan(100);
  });
});

describe('the protocol-<scheme> family lists exactly the sdk request/stream schemes', () => {
  it('is derived, not maintained', () => {
    const channels = snapshot('sdk').channels as Record<string, { kind?: string }>;
    // An exact mirror of check-protocol-snapshot.mjs: it filters on KIND alone and strips
    // the prefix defensively. A `startsWith('protocol-')` clause here agrees today and
    // would silently diverge on a future non-prefixed request channel — which the
    // extractor would list under its full name. The request+stream pair is deliberate:
    // `protocol-fetch` is excluded by both, which is why the list has no `fetch`.
    const derived = Object.entries(channels)
      .filter(([, c]) => c.kind === 'request' || c.kind === 'stream')
      .map(([n]) => n.replace(/^protocol-/, ''))
      .sort();
    const declared = ((snapshot('sdk').dynamicFamilies ?? {}) as Record<string, { schemes?: string[] }>)[
      'protocol-<scheme>'
    ]?.schemes;
    expect(declared).toEqual(derived);
  });
});

// R3-874 — the urlchange payload is typed now (it was `any`), and `replace` is the
// optional field APP_CUSTOMIZATION_SPEC §5 adds. Pin the whole declared shape so a
// later edit cannot quietly drop a field the SDK's navigate() has always sent.
describe('urlchange carries its real shape (R3-874)', () => {
  it("the sdk snapshot declares url/back/forward plus optional entryState/viewedDocument/replace", () => {
    const ch = snapshot('sdk').channels['urlchange'] as unknown as {
      payload: { fields: { name: string; optional: boolean; type?: string; union?: { type: string }[] }[] };
    };
    const byName = new Map(ch.payload.fields.map((f) => [f.name, f]));
    expect([...byName.keys()]).toEqual(['back', 'entryState', 'forward', 'replace', 'url', 'viewedDocument']);
    expect(byName.get('url')).toMatchObject({ optional: false, type: 'string' });
    expect(byName.get('back')).toMatchObject({ optional: false, type: 'boolean' });
    expect(byName.get('forward')).toMatchObject({ optional: false, type: 'boolean' });
    expect(byName.get('replace')).toMatchObject({ optional: true, union: [{ type: 'false' }, { type: 'true' }, { type: 'undefined' }] });
    expect(byName.get('entryState')).toMatchObject({
      optional: true,
      union: [{ type: 'Record<string, unknown>' }, { type: 'undefined' }],
    });
    expect(byName.get('viewedDocument')).toMatchObject({
      optional: true,
      union: [{ type: 'null' }, { type: 'string' }, { type: 'undefined' }],
    });
  });
});

// R3-861 — `fetch` gains the opt-in `responseType` field (binary responses
// uncorrupted). Pinned in the R3-874 style: the publish is immutable, and this
// repo is the last place that can change the answer.
describe("protocol-fetch fetch carries responseType (R3-861)", () => {
  it("the sdk snapshot declares the field as optional 'text' | 'bytes' | undefined", () => {
    const ch = snapshot('sdk').channels['protocol-fetch'] as unknown as {
      methods: Record<string, { payload: { fields: { name: string; optional: boolean; type?: string; union?: { type: string }[] }[] } }>;
    };
    const byName = new Map(ch.methods.fetch.payload.fields.map((f) => [f.name, f]));
    expect([...byName.keys()]).toEqual(['body', 'headers', 'method', 'responseType', 'url']);
    expect(byName.get('responseType')).toMatchObject({
      optional: true,
      union: [{ type: '"bytes"' }, { type: '"text"' }, { type: 'undefined' }],
    });
  });
});

// R3-984 — `run` gains the two recovery inputs: forceUpdateBranch (CONTRIBUTE_SPEC §8.8)
// and the open-pr resume (CT-6). Pinned in the R3-874 style before the publish.
describe('protocol-contribute run carries forceUpdateBranch and resume (R3-984)', () => {
  it('the sdk snapshot declares both as optional, resume as the open-pr member', () => {
    const ch = snapshot('sdk').channels['protocol-contribute'] as unknown as {
      methods: Record<
        string,
        { payload: { fields: { name: string; optional: boolean; type?: string; union?: unknown[] }[] } }
      >;
    };
    const byName = new Map(ch.methods.run.payload.fields.map((f) => [f.name, f]));
    expect([...byName.keys()]).toEqual([
      'branchName',
      'commitMessage',
      'forceUpdateBranch',
      'mode',
      'resume',
      'transcriptRequested',
    ]);
    expect(byName.get('forceUpdateBranch')).toMatchObject({
      optional: true,
      union: [{ type: 'false' }, { type: 'true' }, { type: 'undefined' }],
    });
    expect(byName.get('resume')).toMatchObject({
      optional: true,
      union: [
        {
          fields: [
            { name: 'context', optional: false, type: 'OpenPRResumeContext' },
            { name: 'kind', optional: false, type: '"open-pr"' },
          ],
        },
        { type: 'undefined' },
      ],
    });
  });
});

// R3-964/986/987 — the vcs-state value gains the contribute forms' facts, every one
// optional (an old host omits it). Pinned before the publish, like the run fields above.
describe('vcs-state carries the save-form facts (R3-964/986/987)', () => {
  type Field = { name: string; optional: boolean; type?: string; union?: unknown[] };
  const vcsState = () =>
    snapshot('sdk').channels['vcs-state'] as unknown as { payload: { reads: string[] }; value: { fields: Field[] } };

  it('the sdk snapshot declares each new field optional, beside the existing five', () => {
    const byName = new Map(vcsState().value.fields.map((f) => [f.name, f]));
    expect([...byName.keys()]).toEqual([
      'agentSession',
      'branch',
      'canPushUpstream',
      'changes',
      'defaultSaveMode',
      'diffError',
      'diffLoading',
      'diffWarnings',
      'excludedPhantoms',
      'manifestMissing',
      'manifestTruncated',
      'openPR',
      'prs',
      'target',
    ]);
    for (const k of ['agentSession', ...[
      'canPushUpstream',
      'defaultSaveMode',
      'diffError',
      'diffWarnings',
      'excludedPhantoms',
      'manifestMissing',
      'manifestTruncated',
      'openPR',
      'target',
    ]]) {
      expect(byName.get(k)).toMatchObject({ optional: true });
    }
    for (const k of ['branch', 'changes', 'diffLoading', 'prs']) {
      expect(byName.get(k)).toMatchObject({ optional: false });
    }
  });

  // Pinned whole (type and every union member), so a wrong transcription fails here
  // before the publish rather than in the SDK's gate after it.
  it("pins each new field's shape", () => {
    const byName = new Map(vcsState().value.fields.map(({ name, ...rest }) => [name, rest]));
    const expected: Record<string, Omit<Field, 'name'>> = {
      canPushUpstream: { optional: true, union: [{ type: 'false' }, { type: 'null' }, { type: 'true' }, { type: 'undefined' }] },
      defaultSaveMode: { optional: true, union: [{ type: '"direct"' }, { type: '"pr"' }, { type: 'undefined' }] },
      diffError: { optional: true, union: [{ type: 'null' }, { type: 'string' }, { type: 'undefined' }] },
      diffWarnings: { optional: true, union: [{ type: 'string[]' }, { type: 'undefined' }] },
      excludedPhantoms: { optional: true, union: [{ type: 'string[]' }, { type: 'undefined' }] },
      manifestMissing: { optional: true, union: [{ type: 'false' }, { type: 'true' }, { type: 'undefined' }] },
      manifestTruncated: { optional: true, union: [{ type: 'false' }, { type: 'true' }, { type: 'undefined' }] },
      openPR: { optional: true, union: [{ type: 'null' }, { type: 'undefined' }, { type: '{ number: number; url: string; }' }] },
      target: { optional: true, union: [{ type: 'VcsTarget' }, { type: 'null' }, { type: 'undefined' }] },
    };
    for (const [k, shape] of Object.entries(expected)) expect(byName.get(k)).toEqual(shape);
  });

  it('records every field the sdk parser reads', () => {
    expect(vcsState().payload.reads).toEqual([
      'agentSession',
      'branch',
      'canPushUpstream',
      'changes',
      'defaultSaveMode',
      'diffError',
      'diffLoading',
      'diffWarnings',
      'excludedPhantoms',
      'manifestMissing',
      'manifestTruncated',
      'openPR',
      'prs',
      'target',
    ]);
  });
});

// The task callee pulls its input. Pinned whole, because a published name is permanent and
// the SDK's own gate only checks that its source matches whatever this repo publishes.
describe('request-task-input is an app->host message with no payload', () => {
  it('the sdk snapshot declares it, and the frame does not speak it', () => {
    expect(snapshot('sdk').channels['request-task-input']).toMatchObject({
      kind: 'message',
      direction: 'app->host',
      payload: { fields: [] },
    });
    expect(snapshot('sandbox').channels['request-task-input']).toBeUndefined();
    // What it replays stays what it was: a host->app message, not a push with a poll twin.
    expect(snapshot('sdk').channels['task-input']).toMatchObject({ kind: 'message', direction: 'host->app' });
  });
});

// `modeSelection` rides beside `modeId` on the theme push: what was chosen, where `modeId`
// is what is on screen.
describe('theme carries modeSelection beside modeId', () => {
  type Field = { name: string; optional: boolean; type?: string; union?: { type: string }[] };

  it('the SDK reads it and types it a string on the value it exposes', () => {
    const ch = snapshot('sdk').channels['theme'] as unknown as {
      poll: string;
      payload: { reads: string[] };
      value: { fields: Field[] };
    };
    expect(ch.poll).toBe('request-theme');
    expect(ch.payload.reads).toEqual(['modeId', 'modeSelection', 'theme', 'themeKey']);
    const byName = new Map(ch.value.fields.map((f) => [f.name, f]));
    expect([...byName.keys()]).toEqual(['modeId', 'modeSelection', 'theme', 'themeKey']);
    expect(byName.get('modeSelection')).toMatchObject({ optional: false, type: 'string' });
    expect(byName.get('modeId')).toMatchObject({ optional: false, type: 'string' });
  });

  it('the frame declares it optional — a host that predates the field does not send it — and does not read it', () => {
    const ch = snapshot('sandbox').channels['theme'] as unknown as { payload: { fields: Field[]; reads: string[] } };
    const byName = new Map(ch.payload.fields.map((f) => [f.name, f]));
    expect([...byName.keys()]).toEqual(['modeId', 'modeSelection', 'theme', 'themeKey']);
    expect(byName.get('modeSelection')).toMatchObject({
      optional: true,
      union: [{ type: 'string' }, { type: 'undefined' }],
    });
    expect(ch.payload.reads).toEqual(['modeId', 'theme', 'themeKey']);
  });
});

// The frame already reports its document height. A second name for the same datum was
// proposed and withdrawn before publishing; this is the one a host listens for.
describe('resize is the frame’s content-height report', () => {
  it('is an app->host message carrying a required numeric height', () => {
    expect(snapshot('sandbox').channels['resize']).toMatchObject({
      kind: 'message',
      direction: 'app->host',
      payload: { fields: [{ name: 'height', optional: false, type: 'number' }] },
    });
  });
});

// A file manager asks the host to open a bundle in its own tab. The app names the directory
// it holds, as a capability, and optionally a view by name — never a URL, a route or an app.
// Pinned whole: an extra field here would be a way for an app to steer the destination.
describe('protocol-openbundle open carries a directory capability and a view name, nothing else', () => {
  type Field = { name: string; optional: boolean; type?: string; union?: { type: string }[]; fields?: Field[] };

  it('the sdk snapshot declares `dir` as the four capability fields and `view` as an optional string', () => {
    const ch = snapshot('sdk').channels['protocol-openbundle'] as unknown as {
      kind: string;
      direction: string;
      methods: Record<string, { payload: { fields: Field[] } }>;
    };
    expect({ kind: ch.kind, direction: ch.direction }).toEqual({ kind: 'request', direction: 'app->host' });
    expect(Object.keys(ch.methods)).toEqual(['open']);
    const byName = new Map(ch.methods.open.payload.fields.map((f) => [f.name, f]));
    expect([...byName.keys()]).toEqual(['dir', 'view']);
    const dir = new Map((byName.get('dir')!.fields ?? []).map((f) => [f.name, f]));
    expect(byName.get('dir')!.optional).toBe(false);
    expect([...dir.keys()]).toEqual(['$cap', 'mode', 'mountId', 'relPath']);
    expect(dir.get('$cap')).toMatchObject({ optional: false, type: '"dir"' });
    expect(dir.get('mode')).toMatchObject({ optional: false, union: [{ type: '"ro"' }, { type: '"rw"' }] });
    expect(dir.get('mountId')).toMatchObject({ optional: false, type: 'string' });
    expect(dir.get('relPath')).toMatchObject({ optional: false, type: 'string' });
    expect(byName.get('view')).toMatchObject({ optional: true, union: [{ type: 'string' }, { type: 'undefined' }] });
  });

  it('is in the sdk scheme family and the frame does not speak it', () => {
    expect(snapshot('sandbox').channels['protocol-openbundle']).toBeUndefined();
    const families = (snapshot('sdk') as unknown as { dynamicFamilies: Record<string, { schemes: string[] }> })
      .dynamicFamilies;
    expect(families['protocol-<scheme>'].schemes).toContain('openbundle');
  });
});

// R3-954 — the six bundle history reads (COLLABORATION_SESSIONS §16) beside `<dynamic>`.
// Pinned whole before the immutable publish: each method's fields, their optionality, and
// the `T | undefined` union an optional field must carry (R3-633f) — a drifted hand edit
// regenerates consistently and would otherwise surface only in the SDK after publishing.
describe('protocol-vcs carries the six bundle history methods with exact fields', () => {
  type Field = { name: string; optional: boolean; type?: string; union?: { type: string }[]; array?: { type: string } };
  const ch = () =>
    snapshot('sdk').channels['protocol-vcs'] as unknown as {
      kind: string;
      direction: string;
      methods: Record<string, { payload: { fields?: Field[]; type?: string } }>;
    };
  const required = (name: string, type: string) => ({ name, optional: false, type });
  const optional = (name: string, type: string) => ({ name, optional: true, union: [{ type }, { type: 'undefined' }] });

  it('keeps <dynamic> and adds exactly the six methods', () => {
    expect({ kind: ch().kind, direction: ch().direction }).toEqual({ kind: 'request', direction: 'app->host' });
    expect(Object.keys(ch().methods)).toEqual([
      '<dynamic>',
      'bundleCanWrite',
      'bundleDiffPaths',
      'bundleHead',
      'bundleIsAncestor',
      'bundleLog',
      'bundleRead',
    ]);
    expect(ch().methods['<dynamic>'].payload).toEqual({ type: 'Record<string, unknown>' });
  });

  it.each([
    ['bundleHead', [required('mountId', 'string')]],
    ['bundleCanWrite', [required('mountId', 'string')]],
    ['bundleDiffPaths', [required('from', 'string'), required('mountId', 'string'), required('to', 'string')]],
    ['bundleIsAncestor', [required('a', 'string'), required('b', 'string'), required('mountId', 'string')]],
    [
      'bundleLog',
      [optional('max', 'number'), required('mountId', 'string'), optional('since', 'string'), optional('until', 'string')],
    ],
    [
      'bundleRead',
      [required('mountId', 'string'), { name: 'paths', optional: false, array: { type: 'string' } }, required('sha', 'string')],
    ],
  ])('%s', (method, fields) => {
    expect(ch().methods[method].payload.fields).toEqual(fields);
  });
});
