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
 * Pins the suppression matrix against the harness's own escalation rules.
 *
 * The escalation prose fixtures below are copied VERBATIM from the shipped
 * `@deepseek-ai/dsh-tool-bash` and `@deepseek-ai/dsh-tool-fs` descriptions. If
 * a DSH upgrade reworks that wording, the last two tests fail rather than the
 * package silently stopping to strip prose — which is the whole point of
 * pinning them.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  escalationCorrection,
  isUnusableEscalation,
  narrowTool,
  narrowTools,
  stripEscalationProse,
  widerModesFor,
} from '../lib/index.js'

const ESCALATION_TARGETS = ['workspace-write', 'danger-full-access']

/** The escalation paragraph exactly as `dsh-tool-bash` appends it. */
const BASH_PROSE =
  ' Attempting a command the sandbox may deny is safe and expected: run it and read the marker rather than assuming the denial. When a command is denied and a wider mode would let it succeed, escalate immediately in the same turn — the one sanctioned exception to a denial: retry the exact same command once with `sandbox_permissions` (the narrowest wider mode that suffices) plus a one-sentence `justification`. Do not detour through chat to ask permission first — the approval prompt raised by that retry is how the user consents. If the session states approval prompts are disabled, there is no exception: a denial is final — do not set `sandbox_permissions`. Never escalate speculatively: ground the request in a real denial — normally the one this command just hit; escalating up front is fine only when this session already denied the same access. A rejected escalation is final for that command — stop and explain, never work around it — but it does not forbid attempting or escalating other commands later.'

/** The escalation paragraph exactly as `dsh-tool-fs` appends it. */
const FS_PROSE =
  ' Attempting an operation the sandbox may deny is safe and expected: run it and read the marker rather than assuming the denial. When an operation is denied and a wider mode would let it succeed, escalate immediately in the same turn — the one sanctioned exception to a denial: retry the exact same operation once with `sandbox_permissions` (the narrowest wider mode that suffices) plus a one-sentence `justification`.'

const BASH_BASE =
  'Execute a bash command (`bash -c`) and return its stdout/stderr. Long output is truncated to its tail.'

function bashTool({ withEscalation = true, enumValues = ESCALATION_TARGETS } = {}) {
  const properties = { command: { type: 'string' }, description: { type: 'string' } }
  if (withEscalation) {
    properties.sandbox_permissions = { type: 'string', enum: [...enumValues] }
    properties.justification = { type: 'string' }
  }
  return {
    name: 'bash',
    description: BASH_BASE + (withEscalation ? BASH_PROSE : ''),
    parameters: { type: 'object', properties, required: ['command'] },
  }
}

// ---------------------------------------------------------------------------
// The strictly-wider table must agree with approveEscalation.
// ---------------------------------------------------------------------------

test('a session at the ceiling can grant nothing', () => {
  assert.deepEqual(widerModesFor('danger-full-access'), [])
})

test('workspace-write can grant only full access', () => {
  assert.deepEqual(widerModesFor('workspace-write'), ['danger-full-access'])
})

test('read-only can grant both wider modes', () => {
  assert.deepEqual(widerModesFor('read-only'), ['workspace-write', 'danger-full-access'])
})

test('an unknown mode grants nothing rather than everything', () => {
  assert.deepEqual(widerModesFor('no-such-mode'), [])
})

// ---------------------------------------------------------------------------
// Each value the advertised enum can offer is judged exactly as
// approveEscalation judges it.
// ---------------------------------------------------------------------------

test('escalation requests are unusable exactly when not strictly wider', () => {
  // The reported failure: enum offers danger-full-access, session is already there.
  assert.equal(isUnusableEscalation('danger-full-access', 'danger-full-access'), true)
  // The model's second attempt: a reduction is not an escalation.
  assert.equal(isUnusableEscalation('workspace-write', 'danger-full-access'), true)
  // The genuine escalation the field exists for.
  assert.equal(isUnusableEscalation('danger-full-access', 'workspace-write'), false)
  assert.equal(isUnusableEscalation('workspace-write', 'read-only'), false)
  assert.equal(isUnusableEscalation('danger-full-access', 'read-only'), false)
  // A value outside the vocabulary is never grantable.
  assert.equal(isUnusableEscalation('read-only', 'read-only'), true)
})

// ---------------------------------------------------------------------------
// The fix: nothing impossible is published.
// ---------------------------------------------------------------------------

test('the reported case publishes no escalation fields at all', () => {
  const [tool] = narrowTools([bashTool()], 'danger-full-access')
  assert.equal(tool.parameters.properties.sandbox_permissions, undefined)
  assert.equal(tool.parameters.properties.justification, undefined)
  // The base guidance survives; only the escalation paragraph is removed.
  assert.match(tool.description, /Execute a bash command/)
  assert.doesNotMatch(tool.description, /sandbox_permissions/)
  assert.doesNotMatch(tool.description, /escalate immediately/)
})

test('a narrower session keeps the field but drops the unusable reduction', () => {
  const [tool] = narrowTools([bashTool()], 'workspace-write')
  assert.deepEqual(tool.parameters.properties.sandbox_permissions.enum, ['danger-full-access'])
  // The prose still applies, because escalation is genuinely available here.
  assert.match(tool.description, /escalate immediately/)
})

test('read-only sessions keep the full advertised vocabulary', () => {
  const original = bashTool()
  const [tool] = narrowTools([original], 'read-only')
  assert.equal(tool, original, 'an unaffected tool must not be replaced')
  assert.deepEqual(tool.parameters.properties.sandbox_permissions.enum, ESCALATION_TARGETS)
})

test('an absent mode leaves the surface untouched', () => {
  const original = bashTool()
  assert.equal(narrowTools([original], undefined)[0], original)
})

test('an unrecognised mode fails closed and grants nothing', () => {
  // `SandboxMode` is a validated closed union, so this cannot arise from a
  // healthy host; if it ever does, offering an escalation is the unsafe guess.
  const [tool] = narrowTools([bashTool()], 'no-such-mode')
  assert.equal(tool.parameters.properties.sandbox_permissions, undefined)
  assert.equal(tool.parameters.properties.justification, undefined)
})

test('tools without the escalation pair are never rewritten', () => {
  const plain = { name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: {} } }
  assert.equal(narrowTools([plain], 'workspace-write')[0], plain)
})

test('an escalation pair missing one half still triggers suppression', () => {
  const halfTool = {
    name: 'write',
    description: FS_PROSE,
    parameters: {
      type: 'object',
      properties: { sandbox_permissions: { type: 'string', enum: [...ESCALATION_TARGETS] } },
    },
  }
  // Only `justification` is absent; the pair is incomplete, so nothing is claimed.
  assert.equal(narrowTool(halfTool, 'danger-full-access'), halfTool)
})

test('an enum that cannot be read is treated as unusable', () => {
  const weird = {
    name: 'bash',
    description: BASH_BASE,
    parameters: { type: 'object', properties: { sandbox_permissions: { type: 'string' }, justification: { type: 'string' } } },
  }
  const narrowed = narrowTool(weird, 'danger-full-access')
  assert.equal(narrowed.parameters.properties.sandbox_permissions, undefined)
})

// ---------------------------------------------------------------------------
// Prose stripping is anchored on the shipped wording.
// ---------------------------------------------------------------------------

test('the bash escalation paragraph is removed and the base text is kept', () => {
  const stripped = stripEscalationProse(BASH_BASE + BASH_PROSE)
  assert.equal(stripped, BASH_BASE)
})

test('the fs escalation paragraph is removed and the base text is kept', () => {
  const base = 'Create or fully replace a UTF-8 text file.'
  assert.equal(stripEscalationProse(base + FS_PROSE), base)
})

test('a description that never named the field is returned unchanged', () => {
  const text = 'Read a file from disk. Nothing about escalation here.'
  assert.equal(stripEscalationProse(text), text)
})

test('the tool description cannot be reduced to nothing', () => {
  // A description consisting only of escalation prose keeps its original text
  // rather than publishing an empty description.
  assert.equal(stripEscalationProse(BASH_PROSE.trimStart()), BASH_PROSE.trimStart())
})

test('stripping is idempotent', () => {
  const once = stripEscalationProse(BASH_BASE + BASH_PROSE)
  assert.equal(stripEscalationProse(once), once)
})

// ---------------------------------------------------------------------------
// The correction text names the repair the harness withholds.
// ---------------------------------------------------------------------------

test('a ceiling correction names the effective mode, offers no option, and names the repair', () => {
  const text = escalationCorrection('danger-full-access', 'danger-full-access')
  assert.match(text, /not available in this session/)
  assert.match(text, /already "danger-full-access"/)
  assert.match(text, /are: none/)
  assert.match(text, /omitted/)
  assert.match(text, /Do not retry with a different value/)
})

test('a workspace-write correction names the one real option', () => {
  const text = escalationCorrection('workspace-write', 'workspace-write')
  assert.match(text, /are: danger-full-access/)
})
