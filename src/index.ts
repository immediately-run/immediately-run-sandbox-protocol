// @immediately-run/sandbox-protocol — the sandbox↔SDK wire protocol.
//
// ONE definition (`src/descriptors.protocol.mjs`), projected into four artifacts and
// published so BOTH sides consume the same version instead of one side copying a file
// to the other (PLATFORM_LAYERING_SPEC §2 / S1; built by R3-274b in the sandbox repo,
// moved here by R3-274b1).
//
//   @immediately-run/sandbox-protocol/sandbox   the frame's constants + payload types
//   @immediately-run/sandbox-protocol/sdk       the SDK's constants + payload types
//   …/snapshots/sandbox.json, …/snapshots/sdk.json   the per-side snapshots each
//                                               repo's own gate compares against
//
// The two sides speak overlapping but DIFFERENT subsets — 34 wire names in the frame,
// 57 in the SDK, 18 shared; 39 are SDK-only because the frame merely relays them and
// the host is the other end. Hence a module per side: a union module would hand each
// repo constants it does not speak, and each repo's gate asserts its module covers
// EXACTLY its own wire surface.
//
// This entry point deliberately exports no constants. Importing it must not be a way
// to reach the other side's vocabulary, and it must not drag either module into a
// bundle graph that only wanted the version.

/** The snapshot format both sides' `protocol-snapshot.json` files are written in. */
export const PROTOCOL_FORMAT_VERSION = 1;

/** Which side of the wire a projection describes. */
export type ProtocolSide = 'sandbox' | 'sdk';

/**
 * How a wire name is used.
 *
 * `message` one-way; `push` a host→app state channel; `poll` its `request-*` twin;
 * `request` a `protocol-<scheme>` request/reply; `stream` a streamed reply. A name
 * used two ways carries both, joined — `request+stream`.
 */
export type WireKind = 'message' | 'push' | 'poll' | 'request' | 'stream' | string;

/** Direction, written from the FRAME's point of view on both sides. */
export type WireDirection = 'app->host' | 'host->app' | 'both';

/** One field of a payload: name, optionality, and its shape. */
export interface WireField {
  name: string;
  optional: boolean;
  type?: string;
  union?: WireShape[];
  array?: WireShape;
  tuple?: WireShape[];
  fields?: WireField[];
}

/** A payload shape: expanded fields, a union, an array/tuple, or a type text. */
export interface WireShape {
  fields?: WireField[];
  union?: WireShape[];
  array?: WireShape;
  tuple?: WireShape[];
  type?: string;
  /** Field names the side actually reads off the message, when it declares no type. */
  reads?: string[];
}

/** One wire name's entry in a snapshot. */
export interface WireChannel {
  kind: WireKind;
  direction: WireDirection;
  /** Push channels: the `request-*` name that polls them. */
  poll?: string;
  /** Request/stream names: one payload per method — same name, different params. */
  methods?: Record<string, { payload: WireShape }>;
  payload?: WireShape;
  /** Push channels: the VALUE the channel carries, distinct from the message. */
  value?: WireShape;
  sites: string[];
  /**
   * Set when the two sides disagree about this name's shape. Phase 1 recorded them;
   * R3-274e resolves each and clears the marker, so a snapshot with none is the goal
   * state rather than the normal one.
   */
  divergent?: boolean;
  divergentNote?: string;
}

/** One side's snapshot, as published under `./snapshots/<side>.json`. */
export interface ProtocolSnapshot {
  formatVersion: typeof PROTOCOL_FORMAT_VERSION;
  /** The package name of the side this describes. */
  repo: string;
  channels: Record<string, WireChannel>;
  /** Names minted from a template at runtime: the scheme LIST, never a wildcard. */
  dynamicFamilies: Record<string, { schemes: string[]; sites: string[] }>;
  /** The framing every message on this side rides. */
  envelopes: Record<string, unknown>;
}
