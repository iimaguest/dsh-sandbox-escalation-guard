/*
 * Copyright 2026 iimaguest
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * Drift guard for the mirrored escalation ladder.
 *
 * `lib/wider-modes.js` copies the table `@deepseek-ai/dsh-sandbox` exports, so
 * this package needs no runtime dependency. A copy can drift, so whenever the
 * harness is resolvable — in a dev checkout, or inside a real DSH install — this
 * compares the two and fails if `dsh-sandbox` ever changes the ladder.
 *
 * When the harness cannot be found (a bare clone of this repo with no DSH
 * installed) the check is skipped rather than failed: there is nothing to
 * compare against, and the plugin itself never needs the harness at runtime.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { WIDER_MODES } from '../lib/wider-modes.js'

const require = createRequire(import.meta.url)

/**
 * Harness install locations to try, most specific first. All are derived at
 * runtime — no machine-specific path is committed here.
 */
const CANDIDATES = [
  import.meta.url,
  join(homedir(), '.dsh', 'profiles', 'web', 'package.json'),
  join(homedir(), '.dsh'),
]

async function loadHarnessTable() {
  for (const base of CANDIDATES) {
    try {
      const req = createRequire(base)
      const entry = req.resolve('@deepseek-ai/dsh-sandbox')
      const mod = await import(entry)
      if (mod.WIDER_MODES !== undefined) return mod.WIDER_MODES
    } catch {
      // Try the next base; not being resolvable is a supported case.
    }
  }
  return undefined
}

test('the mirrored ladder matches the harness whenever the harness is present', async (t) => {
  const harness = await loadHarnessTable()
  if (harness === undefined) {
    t.skip('@deepseek-ai/dsh-sandbox is not resolvable here; nothing to compare against')
    return
  }
  assert.deepEqual(
    WIDER_MODES,
    harness,
    'the mirrored ladder drifted from @deepseek-ai/dsh-sandbox — update lib/wider-modes.js',
  )
})

test('the mirrored ladder has the shape the plugin depends on', () => {
  // The ceiling must be absent: that absence IS the fix.
  assert.equal(Object.hasOwn(WIDER_MODES, 'danger-full-access'), false)
  assert.deepEqual(WIDER_MODES['read-only'], ['workspace-write', 'danger-full-access'])
  assert.deepEqual(WIDER_MODES['workspace-write'], ['danger-full-access'])
})
