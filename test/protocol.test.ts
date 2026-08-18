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
    // 39 SDK-only names are the ones the frame merely RELAYS (the host is the other
    // end); the sandbox-only ones are frame↔host business the SDK never sees.
    expect(sdkOnly.length).toBeGreaterThan(30);
    expect(sandboxOnly.length).toBeGreaterThan(10);
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
