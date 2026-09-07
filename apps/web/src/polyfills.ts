/**
 * `Buffer` for the browser.
 *
 * `packages/sdk` derives PDAs with `Buffer.from(...)` **at module level** (see
 * `pda.ts`), and Anchor encodes instructions with it too. In Node it is a built-in global,
 * in the browser it is absent — and the crash looks like "ReferenceError: Buffer is not
 * defined" before the first render.
 *
 * Why a separate entry rather than the first line of `main.tsx`: imports run in the
 * order they are written, and the import order in a file is kept by the sorter
 * (`biome check` verifies it on every gate). A polyfill that
 * fixes the build exactly until someone sorts the imports is not
 * a polyfill. `index.html` loads this module as a separate tag before
 * `main.tsx`: nobody sorts tag order.
 */

import { Buffer } from 'buffer'

const scope = globalThis as typeof globalThis & { Buffer?: typeof Buffer }

scope.Buffer ??= Buffer
