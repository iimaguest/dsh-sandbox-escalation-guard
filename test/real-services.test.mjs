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
 * The gate, mounted against the harness's REAL services.
 *
 * `mount.test.mjs` drives the assemble path through the `escalationPossible`
 * testing seam. That proves the plugin's own logic, but it cannot prove the
 * plugin reads the *harness's* approval fact correctly — a fake
 * `{ effectivePolicy: () => 'never' }` agrees with any implementation,
 * including a wrong one.
 *
 * So this file mounts the actual `ApprovalService` and `SandboxPolicy` and
 * asserts the observable contract across every mode:
 *
 *   policy `never` -> the escalation fields are absent, in EVERY mode
 *   policy `ask`   -> the surface is byte-identical, in EVERY mode
 *
 * The second row is what protects the prompt cache: the tools block is the front
 * of the cached prefix, so if it moved with the access level, every mode switch
 * would discard the entire cached conversation behind it.
 *
 * When the harness is not resolvable (a bare clone with no DSH installed) the
 * checks are skipped rather than failed: the plugin itself never needs the
 * harness at runtime.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { apply, name, inject } from '../lib/index.js'

/** Harness install locations to try, most specific first. */
const CANDIDATES = [
  import.meta.url,
  join(homedir(), '.dsh', 'profiles', 'web', 'package.json'),
  join(homedir(), '.dsh'),
]

async function loadHarness() {
  for (const base of CANDIDATES) {
    try {
      const req = createRequire(base)
      const [cordis, projection, sandboxPolicy, approval, systemPrompt] = await Promise.all([
        import(req.resolve('@deepseek-ai/cordis')),
        import(req.resolve('@deepseek-ai/dsh-session-projection')),
        import(req.resolve('@deepseek-ai/dsh-sandbox-policy')),
        import(req.resolve('@deepseek-ai/dsh-user-approval')),
        import(req.resolve('@deepseek-ai/dsh-system-prompt')),
      ])
      return {
        Context: cordis.Context,
        SessionProjection: projection.default ?? projection,
        SandboxPolicy: sandboxPolicy.default ?? sandboxPolicy,
        Approval: approval.default ?? approval,
        SystemPrompt: systemPrompt.default ?? systemPrompt,
      }
    } catch {
      // Try the next base; not being resolvable is a supported case.
    }
  }
  return undefined
}

/** The bash escalation surface, shaped as `dsh-tool-bash` builds it. */
const BASH = {
  name: 'bash',
  description:
    'Execute a bash command (`bash -c`). Retry with `sandbox_permissions` plus a one-sentence `justification`.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      sandbox_permissions: { type: 'string', enum: ['workspace-write', 'danger-full-access'] },
      justification: { type: 'string' },
    },
    required: ['command'],
  },
}

const MODES = ['read-only', 'workspace-write', 'danger-full-access']

/** Mount the real services, then the guard, and read what the model would see. */
async function assembleWith(h, { mode, policy }) {
  const ctx = new h.Context()
  await ctx.plugin(h.SessionProjection, {})
  await ctx.plugin(h.SystemPrompt, {})
  await ctx.plugin(h.Approval, { policy })
  await ctx.plugin(h.SandboxPolicy, { mode })
  await ctx.plugin({ ...{ name, inject, apply }, apply: (scope) => apply(scope, { warn: false }) })

  const prompt = ctx.get('systemPrompt')
  prompt.tools(() => ({ schemas: [BASH], knownNames: ['bash'] }))

  const session = { id: 'real-services', header: { cwd: process.cwd() }, seq: 0, eventAt: () => undefined }
  const assembly = await prompt.assemble({ scope: { session } })
  console.error('DBG policy=', policy, 'mode=', mode, 'tools=', assembly.tools.map(t => t.name).join(','), 'props=', Object.keys(assembly.tools[0].parameters.properties).join('+'))
  const bash = assembly.tools.find((tool) => tool.name === 'bash')
  return {
    props: Object.keys(bash.parameters.properties),
    bytes: JSON.stringify(assembly.tools),
    effectivePolicy: ctx.get('approval').effectivePolicy(session),
  }
}

test('the real approval service confirms the policy the guard keys on', async (t) => {
  const h = await loadHarness()
  if (h === undefined) {
    t.skip('the harness is not resolvable here; nothing to mount')
    return
  }

  const never = await assembleWith(h, { mode: 'workspace-write', policy: 'never' })
  const ask = await assembleWith(h, { mode: 'workspace-write', policy: 'ask' })

  // The premise, read from the real service rather than assumed.
  assert.equal(never.effectivePolicy, 'never')
  assert.equal(ask.effectivePolicy, 'ask')
})

test('policy never removes the escalation fields in EVERY mode', async (t) => {
  const h = await loadHarness()
  if (h === undefined) {
    t.skip('the harness is not resolvable here; nothing to mount')
    return
  }

  for (const mode of MODES) {
    const { props } = await assembleWith(h, { mode, policy: 'never' })
    assert.deepEqual(
      props,
      ['command'],
      `policy never must strip the fields at ${mode}, not only at the ceiling`,
    )
  }
})

test('policy ask leaves the surface byte-identical in EVERY mode', async (t) => {
  const h = await loadHarness()
  if (h === undefined) {
    t.skip('the harness is not resolvable here; nothing to mount')
    return
  }

  const seen = new Map()
  for (const mode of MODES) {
    const { bytes, props } = await assembleWith(h, { mode, policy: 'ask' })
    assert.deepEqual(props, ['command', 'sandbox_permissions', 'justification'])
    seen.set(mode, bytes)
  }

  // The whole point of the redesign: the access level is not an input to the
  // published surface, so a mode switch cannot move the front of the cache.
  const [first] = seen.values()
  for (const [mode, bytes] of seen) {
    assert.equal(bytes, first, `the published surface moved at ${mode}; that is a cache miss`)
  }
})
