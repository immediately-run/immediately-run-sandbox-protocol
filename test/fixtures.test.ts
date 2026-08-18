import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FIXTURE_NAMES, WIRE_FIXTURES, shapeProblems } from '../src/fixtures';
import type { ProtocolSnapshot, WireChannel, WireShape } from '../src/index';

const snapshot = (side: 'sandbox' | 'sdk'): ProtocolSnapshot =>
  JSON.parse(readFileSync(join(__dirname, `../snapshots/${side}.json`), 'utf8'));

const SIDES = ['sandbox', 'sdk'] as const;

/**
 * Every shape on a channel that actually declares STRUCTURE.
 *
 * The two sides describe the same message differently by design: the frame declares it
 * under `payload`, while the SDK — for which these are push channels — declares the
 * carried value under `value` and records only which keys it `reads` on `payload`. So
 * "the shape to check" is not one field name; it is every shape with `fields`.
 */
const structuralShapes = (c: WireChannel): WireShape[] =>
  [c.payload, c.value].filter((s): s is WireShape => !!s?.fields);

/** Every key any shape on the channel claims to read off the message. */
const readsOf = (c: WireChannel): string[] => [
  ...(c.payload?.reads ?? []),
  ...(c.value?.reads ?? []),
];

describe('the shared fixture is the cross-side proof (R3-274e1)', () => {
  it('covers exactly the names R3-274e resolved', () => {
    // Not "at least" — a name added here without a decision behind it is a fixture
    // asserting something nobody agreed to.
    expect([...FIXTURE_NAMES].sort()).toEqual(['editor-context', 'fs-change', 'sdk-handshake']);
  });

  it('every fixture is spoken by BOTH sides — that is what makes it cross-side', () => {
    for (const name of FIXTURE_NAMES) {
      for (const side of SIDES) {
        expect(Object.keys(snapshot(side).channels)).toContain(name);
      }
    }
  });

  it.each(FIXTURE_NAMES)('%s conforms to both sides’ declared shapes', (name) => {
    const value = WIRE_FIXTURES[name];
    let checked = 0;
    for (const side of SIDES) {
      const channel = snapshot(side).channels[name];
      for (const shape of structuralShapes(channel)) {
        expect({ side, name, problems: shapeProblems(shape, value) }).toEqual({
          side,
          name,
          problems: [],
        });
        checked += 1;
      }
    }
    // A fixture validated against zero shapes is a green test that asserts nothing —
    // the exact failure mode this whole item exists to close. Both sides must have
    // contributed at least one structural declaration.
    expect(checked).toBeGreaterThanOrEqual(SIDES.length);
  });

  it.each(FIXTURE_NAMES)('%s supplies every key either side claims to read', (name) => {
    const value = WIRE_FIXTURES[name];
    for (const side of SIDES) {
      for (const key of readsOf(snapshot(side).channels[name])) {
        expect({ side, key, present: Object.prototype.hasOwnProperty.call(value, key) }).toEqual({
          side,
          key,
          present: true,
        });
      }
    }
  });

  it('no fixture rides a name still marked divergent', () => {
    for (const name of FIXTURE_NAMES) {
      for (const side of SIDES) {
        expect(snapshot(side).channels[name].divergent).toBeFalsy();
      }
    }
  });
});

describe('the validator is falsifiable — proven by injection, not by inspection', () => {
  // `shapeProblems` is the one piece of logic BOTH consuming repos import. A validator
  // that returns [] for everything would make every test above pass while proving
  // nothing, so each of its rejection paths is exercised here against a real shape.
  const fsChange = (): WireShape =>
    structuralShapes(snapshot('sandbox').channels['fs-change'])[0];

  it('accepts the real fixture (no false positive)', () => {
    expect(shapeProblems(fsChange(), WIRE_FIXTURES['fs-change'])).toEqual([]);
  });

  it('detects a REMOVED required field — the property the exit criterion names', () => {
    const withoutEpoch = { ...WIRE_FIXTURES['fs-change'] } as Record<string, unknown>;
    delete withoutEpoch.epoch;
    expect(shapeProblems(fsChange(), withoutEpoch)).toEqual([
      '$.epoch: required by the declaration, absent',
    ]);
  });

  it('detects a field of the WRONG type', () => {
    expect(shapeProblems(fsChange(), { ...WIRE_FIXTURES['fs-change'], epoch: '7' })).toEqual([
      '$.epoch: declared `number`, got string',
    ]);
  });

  it('detects an EXTRA undeclared field', () => {
    expect(shapeProblems(fsChange(), { ...WIRE_FIXTURES['fs-change'], sneaky: 1 })).toEqual([
      '$.sneaky: present but not declared',
    ]);
  });

  it('descends into arrays rather than checking only the container', () => {
    expect(shapeProblems(fsChange(), { ...WIRE_FIXTURES['fs-change'], paths: ['/ok', 42] })).toEqual(
      ['$.paths[1]: declared `string`, got number'],
    );
  });

  it('accepts either leg of a nullable union, and nothing else', () => {
    const ctx = structuralShapes(snapshot('sandbox').channels['editor-context'])[0];
    const base = WIRE_FIXTURES['editor-context'];
    expect(shapeProblems(ctx, { ...base, viewedFile: '/app/x.tsx' })).toEqual([]);
    expect(shapeProblems(ctx, { ...base, activeFile: null })).toEqual([]);
    expect(shapeProblems(ctx, { ...base, activeFile: 3 })).toEqual([
      '$.activeFile: matches no member of the declared union',
    ]);
  });

  it('an OPTIONAL field may be absent but may not be wrong', () => {
    const hs = structuralShapes(snapshot('sdk').channels['sdk-handshake'])[0];
    const rest = { ...WIRE_FIXTURES['sdk-handshake'] } as Record<string, unknown>;
    delete rest.sdkVersion;
    expect(shapeProblems(hs, rest)).toEqual([]);
    expect(shapeProblems(hs, { ...WIRE_FIXTURES['sdk-handshake'], sdkVersion: 44 })).toEqual([
      '$.sdkVersion: matches no member of the declared union',
    ]);
  });

  it('a non-object where an object is declared is a problem, not a crash', () => {
    expect(shapeProblems(fsChange(), null)).toEqual(['$: declared an object, got object']);
    expect(shapeProblems(fsChange(), [])).toEqual(['$: declared an object, got array']);
  });
});
