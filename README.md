# @immediately-run/sandbox-protocol

The **sandbox↔SDK wire protocol**: one descriptor set, projected into the wire-name
constants, the payload types, and the per-side snapshots each repo gates against.

`PLATFORM_LAYERING_SPEC` §2 (S1) target 1 — *"one protocol module, sandbox-owned,
defined in one place and generated into the SDK"*. Built by **R3-274b** inside the
sandbox repo; moved here by **R3-274b1** so both sides *consume* it instead of one
side copying a file to the other.

## Why a package, rather than a file in the sandbox repo

The SDK does not depend on the sandbox — the build order is SDK → sandpack fork →
sandbox → site-main — and reading a sibling checkout at build time is precisely the
coupling **R3-274d** removed. So the generated SDK-side module was, briefly, a file
copied by hand between repos, with a `descriptorsHash` stamp as the only way to tell a
stale copy from a current one.

A copied artifact drifts *silently*: the failure is a wrong wire string at runtime, not
a build error. Publishing it makes staleness a version number, and updating it a
dependency bump.

## What is published

| Entry point | What it is |
|---|---|
| `@immediately-run/sandbox-protocol/sandbox` | the frame's wire-name constants + payload types |
| `@immediately-run/sandbox-protocol/sdk` | the SDK's wire-name constants + payload types |
| `@immediately-run/sandbox-protocol/snapshots/sandbox` | the frame's snapshot, for that repo's gate |
| `@immediately-run/sandbox-protocol/snapshots/sdk` | the SDK's snapshot, for that repo's gate |
| `@immediately-run/sandbox-protocol` | the format version + the snapshot types. **No constants** — importing the root must not be a way to reach the other side's vocabulary |

**Two modules, not a union.** The sides speak overlapping but different subsets — 34
wire names in the frame, 57 in the SDK, 18 shared. 39 are SDK-only because the frame
merely *relays* them and the host is the other end (the R3-274a cross-repo audit). Each
repo's own gate asserts its module covers *exactly* its extracted wire surface, so a
union module would fail there, far from its cause.

## Changing the wire

Edit **`src/descriptors.protocol.mjs`** — never a generated file — then:

```sh
npm run generate     # descriptors → the four projections
npm run verify       # build + tests + lint + drift + dependency-free
```

`npm run check:drift` regenerates into a scratch tree and compares **bytes**, then
proves the snapshots transcribe *back* to the committed descriptors. Generation and
transcription are inverses; if they stop being, the descriptors are no longer the
source of truth but a second copy that happens to agree today.

The wire is **additive-only** (`SDK_PACKAGING_SPEC` §9): an app pins its SDK version
and rides it for as long as it likes, so a renamed or reshaped name breaks apps that
are already published. Add; never rename in place.

## Divergences

A few names still mean different things on the two sides — recorded, not hidden. Each
carries `divergent: true` and a note explaining the disagreement; the tests here fail a
marker without a note, and fail a divergence marked on only one side. **R3-274e**
resolves them and clears the markers, so *zero* markers is the goal state rather than
the normal one.

## Publishing

`main` publishes via npm **trusted publishing** (OIDC — no token). Bump `version` in
`package.json` *and* the lockfile; an unbumped version silently skips the publish and
the registry keeps serving the old bytes. Verify a release by unpacking the published
tarball, not by trusting `npm view … version`: a concurrent PR taking the same version
number is a known silent-skip mode in this org.

## No dependencies, ever

Both sides of the seam depend on this package and it depends on neither — that is what
makes it a safe home for the contract. A runtime dependency here is inherited by every
consumer, including the browser bundle. `npm run check:dependency-free` asserts it in
CI rather than trusting anyone to remember.
