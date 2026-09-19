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
 * Smoke test: apply the real plugin against a real Cordis context and a real
 * systemPrompt registry, then assemble a prompt twice — once with the session
 * at the ceiling and once with it confined — and assert what the model would
 * actually be handed.
 *
 * This is the check the unit tests cannot make: that the file loads as a
 * Cordis plugin, that `inject` resolves, and that the `system-prompt/assemble`
 * listener is actually wired into the registry's waterfall. The registry is
 * instantiated directly rather than resolved from `ctx.systemPrompt`, because
 * a Cordis service property is only readable behind `ctx.inject`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'

import { apply, name, inject } from '../lib/index.js'

const ESCALATION_PROSE =
  ' Attempting a command the sandbox may deny is safe and expected: run it and read the marker rather than assuming the denial. When a command is denied and a wider mode would let it succeed, escalate immediately in the same turn — the one sanctioned exception to a denial: retry the exact same command once with `sandbox_permissions` (the narrowest wider mode that suffices) plus a one-sentence `justification`.'

const SHELL_TOOLS = [{
  name: 'bash',
  description: 'Execute a bash command (`bash -c`) and return its stdout/stderr.' + ESCALATION_PROSE,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      sandbox_permissions: { type: 'string', enum: ['workspace-write', 'danger-full-access'] },
      justification: { type: 'string' },
    },
    required: ['command'],
  },
}]

const SESSION = { id: 's1', header: { cwd: '/w' } }
const AGENT = { session: SESSION }
/** Exactly what `assembleContextFor(agent, signal)` hands a listener. */
const CONTEXT = { scope: AGENT }

/**
 * Mount the plugin exactly as the loader would. The mode is injected through
 * the plugin's own `resolveMode` seam rather than a stub Cordis service, so
 * the wiring under test is the real one — the same code path a live
 * `ctx.sandboxPolicy` feeds in production.
 */
async function mount({ mode }) {
  const ctx = new Context()
  const prompt = new SystemPrompt(ctx, {})
  prompt.tools(() => ({ schemas: SHELL_TOOLS, knownNames: ['bash'] }))
  const fiber = ctx.plugin({
    name,
    inject,
    apply(scope) {
      apply(scope, { warn: false, resolveMode: () => mode })
    },
  })
  // `ctx.plugin` materializes the row asynchronously, exactly as the loader
  // does; the listener exists only once the fiber settles.
  await fiber
  return { ctx, fiber, prompt }
}

test('the plugin file applies and narrows against a live registry', async () => {
  const { prompt } = await mount({ mode: 'danger-full-access' })
  const assembly = await prompt.assemble(CONTEXT)
  const bash = assembly.tools.find((tool) => tool.name === 'bash')

  assert.ok(bash, 'bash must still be published')
  assert.equal(bash.parameters.properties.sandbox_permissions, undefined)
  assert.equal(bash.parameters.properties.justification, undefined)
  assert.doesNotMatch(bash.description, /escalate immediately/)
  assert.match(bash.description, /Execute a bash command/)
})

test('a confined session still receives the escalation field it can use', async () => {
  const { prompt } = await mount({ mode: 'workspace-write' })
  const assembly = await prompt.assemble(CONTEXT)
  const bash = assembly.tools.find((tool) => tool.name === 'bash')

  assert.deepEqual(bash.parameters.properties.sandbox_permissions.enum, ['danger-full-access'])
  assert.ok(bash.parameters.properties.justification)
})

test('disposing the plugin restores the original surface', async () => {
  const { fiber, prompt } = await mount({ mode: 'danger-full-access' })

  const before = await prompt.assemble(CONTEXT)
  assert.equal(before.tools[0].parameters.properties.sandbox_permissions, undefined)

  await fiber.dispose()

  const after = await prompt.assemble(CONTEXT)
  assert.deepEqual(
    after.tools[0].parameters.properties.sandbox_permissions.enum,
    ['workspace-write', 'danger-full-access'],
    'unmounting must leave no trace — that is what makes it an ordinary plugin row',
  )
})

test('a call that still carries an unusable request is corrected, not failed opaquely', async () => {
  const { ctx } = await mount({ mode: 'danger-full-access' })
  const exec = {
    name: 'bash',
    agent: AGENT,
    arguments: { command: 'pwd', sandbox_permissions: 'danger-full-access', justification: 'Read repo state.' },
  }

  let delegated = false
  const decision = await ctx.waterfall('tools/pre-execute', exec, () => {
    delegated = true
    return Promise.resolve({ kind: 'allow' })
  })

  assert.equal(delegated, false, 'the guard must settle the call itself')
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /already "danger-full-access"/)
  assert.match(decision.reason, /omitted/)
})

test('a usable escalation request is delegated untouched', async () => {
  const { ctx } = await mount({ mode: 'workspace-write' })
  const exec = {
    name: 'bash',
    agent: AGENT,
    arguments: { command: 'pwd', sandbox_permissions: 'danger-full-access', justification: 'Needs full access.' },
  }

  const decision = await ctx.waterfall('tools/pre-execute', exec, () => Promise.resolve({ kind: 'allow' }))
  assert.equal(decision.kind, 'allow', 'a genuinely wider request belongs to the harness approval path')
})

test('a call with no escalation arguments is delegated untouched', async () => {
  const { ctx } = await mount({ mode: 'danger-full-access' })
  const exec = { name: 'bash', agent: AGENT, arguments: { command: 'pwd' } }

  const decision = await ctx.waterfall('tools/pre-execute', exec, () => Promise.resolve({ kind: 'allow' }))
  assert.equal(decision.kind, 'allow')
})

/**
 * The regression that reached a live deployment.
 *
 * A bundle patch is appended to the composition, while `sandbox-policy` sits
 * earlier in the base tree and is provided asynchronously. Reading
 * `ctx.get('sandboxPolicy')` once inside `apply` therefore closes over
 * `undefined`: the row loaded, announced itself with a warning, and then
 * narrowed nothing for the whole session.
 *
 * These tests mount the real service AFTER the plugin, and assert that the
 * guard starts working once it arrives.
 */
async function mountWithDeferredPolicy({ mode }) {
  const ctx = new Context()
  const prompt = new SystemPrompt(ctx, {})
  prompt.tools(() => ({ schemas: SHELL_TOOLS, knownNames: ['bash'] }))

  // Mount the plugin first, with no policy in existence yet.
  await ctx.plugin({ name, inject, apply: (scope) => apply(scope, { warn: false }) })
  const beforeService = await prompt.assemble(CONTEXT)

  // Now the policy service arrives, as it does on a real boot.
  ctx.provide('sandboxPolicy')
  ctx.set('sandboxPolicy', { resolve: () => ({ mode }) })

  return { ctx, prompt, beforeService }
}

test('narrowing begins as soon as the policy service arrives after mount', async () => {
  const { prompt, beforeService } = await mountWithDeferredPolicy({ mode: 'danger-full-access' })

  // Before the service existed there was nothing to resolve a mode from, so the
  // surface is left untouched rather than guessed at.
  assert.deepEqual(
    Object.keys(beforeService.tools[0].parameters.properties),
    ['command', 'sandbox_permissions', 'justification'],
    'with no policy available the schema must be left alone, not narrowed against a guess',
  )

  const afterService = await prompt.assemble(CONTEXT)
  assert.deepEqual(
    Object.keys(afterService.tools[0].parameters.properties),
    ['command'],
    'once sandboxPolicy exists the guard must narrow — this is the bug that shipped',
  )
  assert.equal(/escalate immediately/.test(afterService.tools[0].description), false)
})

test('the pre-execute guard also begins working after a deferred policy arrives', async () => {
  const { ctx } = await mountWithDeferredPolicy({ mode: 'danger-full-access' })
  const exec = {
    name: 'bash',
    agent: AGENT,
    arguments: { command: 'pwd', sandbox_permissions: 'danger-full-access', justification: 'Why not.' },
  }

  const decision = await ctx.waterfall('tools/pre-execute', exec, () => Promise.resolve({ kind: 'allow' }))
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /already "danger-full-access"/)
})

test('an absent policy is reported once, not on every request', async () => {
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    const ctx = new Context()
    const prompt = new SystemPrompt(ctx, {})
    prompt.tools(() => ({ schemas: SHELL_TOOLS, knownNames: ['bash'] }))
    await ctx.plugin({ name, inject, apply: (scope) => apply(scope, { warn: true }) })

    await prompt.assemble(CONTEXT)
    await prompt.assemble(CONTEXT)
    await prompt.assemble(CONTEXT)
  } finally {
    console.warn = original
  }

  const mine = warnings.filter((w) => w.includes('sandbox-escalation-guard'))
  assert.equal(mine.length, 1, 'a missing service must be reported without flooding the console per request')
  assert.match(mine[0], /sandboxPolicy is unavailable/)
})
