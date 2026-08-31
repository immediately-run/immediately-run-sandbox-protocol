// One sample message per resolved wire name — the cross-side proof for R3-274e1.
//
// R3-274e resolved three names whose two sides had been declaring different shapes
// under one name (`fs-change`, `editor-context`, `sdk-handshake`; the decisions are in
// PLATFORM_LAYERING_SPEC §6). Each side's `protocol:check` compares that side's source
// against its own snapshot — which proves each side matches the CONTRACT, and proves
// nothing about the two sides matching EACH OTHER. Two snapshots projected from one
// descriptor set will agree by construction until someone edits the descriptors, and
// then they will disagree quietly, because nothing reads both.
//
// This module is the thing that reads both. It carries ONE sample per name, and this
// package's own test validates each sample against BOTH sides' declared shapes at once
// (`fixtures.test.ts`). The consuming repos then drive the SAME object through their
// real parsers. That is what makes deleting a field from a fixture below fail on both
// sides rather than one:
//
//   epoch removed from `fs-change`  →  sandbox: payload.fields requires it
//                                  →  sdk:     value.fields requires it, and
//                                              payload.reads names it
//
// Put a fixture here, never in a consuming repo. A per-repo fixture re-creates exactly
// the "two shapes, one name" condition R3-274e closed — this time in the test data.

/** The shape grammar a snapshot channel is written in (mirrors `WireShape`). */
interface Shape {
  fields?: Field[];
  union?: Shape[];
  array?: Shape;
  tuple?: Shape[];
  type?: string;
  reads?: string[];
}

interface Field {
  name: string;
  optional: boolean;
  type?: string;
  union?: Shape[];
  array?: Shape;
  tuple?: Shape[];
  fields?: Field[];
}

/**
 * A sample message for every wire name R3-274e resolved.
 *
 * Values are deliberately DISTINGUISHABLE — no empty arrays, no all-null unions, no
 * two fields sharing a value — so a parser that drops, reorders or conflates a field
 * produces a visibly different result instead of an accidentally-equal one. Both legs
 * of every nullable union are exercised across the set (`activeFile` a string,
 * `viewedFile` null).
 */
export const WIRE_FIXTURES: Readonly<Record<string, Readonly<Record<string, unknown>>>> =
  Object.freeze({
    // `{paths, epoch}` — both sides declare both fields. The frame reads only `paths`
    // (it recompiles on every batch); the SDK's consumers read `epoch` as an ordering
    // token. Keeping `epoch` was the resolution: apps read it.
    'fs-change': Object.freeze({
      epoch: 7,
      paths: Object.freeze(['/app/src/App.tsx', '/app/content/home.mdx']),
      // R3-409: the mount-anchored leg — a space mount's server-side batch. The
      // two legs are disjoint in traffic (a batch carries one or the other), but
      // ONE fixture carries BOTH so the cross-side proof exercises every key
      // either side declares (the same reason `epoch` rides this fixture).
      mount: Object.freeze({
        path: '/mnt/3f2b9c',
        changes: Object.freeze([
          Object.freeze({ path: '/board.mdx', kind: 'change' }),
          Object.freeze({ path: '/notes/new.md', kind: 'add' }),
        ]),
      }),
    }),

    // The frame's declaration caught up to the host's four fields. What each side
    // CACHES stays a subset; what travels is all four.
    'editor-context': Object.freeze({
      activeFile: '/app/src/App.tsx',
      dirtyPaths: Object.freeze(['/app/src/App.tsx']),
      openFiles: Object.freeze(['/app/src/App.tsx', '/app/src/main.tsx']),
      viewedFile: null,
    }),

    // Two legitimate producers, each populating what it owns — hence the union with
    // every field optional. The fixture populates ALL of them on purpose: a sample
    // that omitted a field could not detect a side that stopped declaring it.
    'sdk-handshake': Object.freeze({
      protocolVersion: '1',
      sandboxProtocolVersion: '2',
      sdkVersion: '0.44.0',
    }),
  });

/** The wire names `WIRE_FIXTURES` covers. */
export const FIXTURE_NAMES: readonly string[] = Object.freeze(Object.keys(WIRE_FIXTURES));

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const primitiveMatches = (type: string, v: unknown): boolean => {
  switch (type) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number';
    case 'boolean':
      return typeof v === 'boolean';
    case 'null':
      return v === null;
    case 'undefined':
      return v === undefined;
    default:
      // A named type (`FsChange`, `EditorContext`) carries no structure here — the
      // sibling `fields` does. Unknown type text is NOT a failure, or every named
      // type would have to be duplicated in this file.
      return true;
  }
};

/**
 * Validate `value` against a snapshot `Shape`, returning one message per problem
 * (empty = conformant). Exported so BOTH consuming repos check the fixture with the
 * same code — a per-repo validator would be one more thing that can agree by accident.
 *
 * Deliberately strict about EXTRA fields: a fixture carrying a key the side does not
 * declare is exactly the drift this is here to catch.
 */
export function shapeProblems(shape: Shape, value: unknown, path = '$'): string[] {
  const problems: string[] = [];

  if (shape.union) {
    const ok = shape.union.some((m) => shapeProblems(m, value, path).length === 0);
    if (!ok) problems.push(`${path}: matches no member of the declared union`);
    return problems;
  }

  if (shape.array) {
    if (!Array.isArray(value)) {
      problems.push(`${path}: declared an array, got ${typeof value}`);
      return problems;
    }
    value.forEach((el, i) => problems.push(...shapeProblems(shape.array!, el, `${path}[${i}]`)));
    return problems;
  }

  if (shape.tuple) {
    if (!Array.isArray(value)) {
      problems.push(`${path}: declared a tuple, got ${typeof value}`);
      return problems;
    }
    if (value.length !== shape.tuple.length) {
      problems.push(`${path}: tuple declares ${shape.tuple.length} slot(s), got ${value.length}`);
      return problems;
    }
    shape.tuple.forEach((m, i) => problems.push(...shapeProblems(m, value[i], `${path}[${i}]`)));
    return problems;
  }

  if (shape.fields) {
    if (!isRecord(value)) {
      problems.push(`${path}: declared an object, got ${Array.isArray(value) ? 'array' : typeof value}`);
      return problems;
    }
    for (const f of shape.fields) {
      const present = Object.prototype.hasOwnProperty.call(value, f.name);
      if (!present) {
        if (!f.optional) problems.push(`${path}.${f.name}: required by the declaration, absent`);
        continue;
      }
      problems.push(...shapeProblems(f as Shape, value[f.name], `${path}.${f.name}`));
    }
    const declared = new Set(shape.fields.map((f) => f.name));
    for (const k of Object.keys(value)) {
      if (!declared.has(k)) problems.push(`${path}.${k}: present but not declared`);
    }
    return problems;
  }

  if (shape.type && !primitiveMatches(shape.type, value)) {
    problems.push(`${path}: declared \`${shape.type}\`, got ${value === null ? 'null' : typeof value}`);
  }
  return problems;
}
