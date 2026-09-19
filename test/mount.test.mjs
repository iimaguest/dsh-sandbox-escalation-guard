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

// ---------------------------------------------------------------------------
// Waterfall chaining.
//
// `system-prompt/assemble` is a chained thunk (`cbs.shift() ?? inner`), so a
// listener that returns WITHOUT calling `next()` ends the chain for every
// listener registered after it. The first version of this plugin did that, and
// no single-listener test could see it — these tests mount a downstream
// listener and assert it still runs.
// ---------------------------------------------------------------------------

test('a listener registered after the guard still runs', async () => {
  const ctx = new Context()
  const prompt = new SystemPrompt(ctx, {})
  prompt.tools(() => ({ schemas: SHELL_TOOLS, knownNames: ['bash'] }))

  let downstreamRan = false
  // Downstream, standing in for dsh-session-reference / dsh-agent.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    downstreamRan = true
    const result = await next()
    return { ...result, downstreamMarker: true }
  })

  // The guard must be mounted FIRST so an un-chained return would cut this off.
  await ctx.plugin({ name, inject, apply: (scope) => apply(scope, { warn: false, resolveMode: () => 'danger-full-access' }) })

  const assembly = await prompt.assemble(CONTEXT)

  assert.equal(downstreamRan, true, 'the guard must not truncate the assemble waterfall')
  assert.equal(assembly.downstreamMarker, true, "a downstream listener's contribution must survive")
  // And the guard's own work must still happen, on the final assembly.
  assert.deepEqual(Object.keys(assembly.tools[0].parameters.properties), ['command'])
})

test('every listener in the chain still contributes, whatever the order', async () => {
  const ctx = new Context()
  const prompt = new SystemPrompt(ctx, {})
  prompt.tools(() => ({ schemas: SHELL_TOOLS, knownNames: ['bash'] }))

  const order = []
  // Registered BEFORE the guard, so a non-chaining guard would cut it off.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    order.push('before')
    const result = await next()
    return { ...result, beforeMarker: true }
  })
  await ctx.plugin({ name, inject, apply: (scope) => apply(scope, { warn: false, resolveMode: () => 'danger-full-access' }) })
  // Registered AFTER the guard, so a guard that returned early would cut it off.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    order.push('after')
    const result = await next()
    return { ...result, afterMarker: true }
  })

  const assembly = await prompt.assemble(CONTEXT)

  assert.deepEqual(order.sort(), ['after', 'before'], 'both neighbours must run')
  assert.equal(assembly.beforeMarker, true)
  assert.equal(assembly.afterMarker, true)
  // And the guard's own work still lands on the final assembly it passes on.
  assert.deepEqual(Object.keys(assembly.tools[0].parameters.properties), ['command'])
})

// ---------------------------------------------------------------------------
// Prefix stability (KV cache).
//
// The guard rewrites request content, so it has to be worth checking that the
// bytes it produces are identical on every request within a session: a rewrite
// that varied per request — a timestamp, a counter, a reordered key — would
// move the cached prefix on every single turn and silently cost the provider
// cache. Constant-for-a-session is the property to hold.
// ---------------------------------------------------------------------------

test('the assembled surface serializes identically on every request', async () => {
  for (const mode of ['danger-full-access', 'workspace-write', 'read-only']) {
    const { prompt } = await mount({ mode })

    const serializations = new Set()
    for (let i = 0; i < 50; i++) {
      const assembly = await prompt.assemble(CONTEXT)
      serializations.add(JSON.stringify(assembly.tools))
    }

    assert.equal(
      serializations.size,
      1,
      `mode ${mode} produced ${serializations.size} distinct tool serializations — a varying prefix would ` +
        'invalidate the provider KV cache on every turn',
    )
  }
})

test('re-assembly preserves the input key order', async () => {
  const { prompt } = await mount({ mode: 'workspace-write' })
  const assembly = await prompt.assemble(CONTEXT)

  // Both fields survive here, because a real escalation is available, and
  // `command` must still lead: a set-like rebuild that reordered properties
  // would change the bytes without changing the meaning.
  assert.deepEqual(
    Object.keys(assembly.tools[0].parameters.properties),
    ['command', 'sandbox_permissions', 'justification'],
  )
})

/**
 * The cache contract, stated the way the providers state it.
 *
 * OpenAI: changing `tools` alters "names, descriptions, schemas, ordering" and
 * invalidates the prefix; its cache-routing hash is computed over the initial
 * tokens "including tool definitions when present". Anthropic: modifying tool
 * definitions invalidates the entire cache (tools, system, messages). DeepSeek
 * matches on fully-matching persisted prefix units.
 *
 * So the guard may change the surface, but only once per session and only
 * deterministically — never per request, and never with a dependency on how
 * many requests came before.
 */
test('the surface is identical regardless of request order', async () => {
  const renders = {}
  const sequence = [
    'read-only', 'danger-full-access', 'workspace-write',
    'danger-full-access', 'read-only', 'workspace-write',
  ]

  for (const mode of sequence) {
    const { prompt } = await mount({ mode })
    const assembly = await prompt.assemble(CONTEXT)
    const render = JSON.stringify(assembly.tools)
    if (!(mode in renders)) renders[mode] = render
    assert.equal(render, renders[mode], `mode ${mode} rendered differently on a later request`)
  }

  assert.equal(Object.keys(renders).length, 3, 'all three modes should have been exercised')
})

test('narrowing never renames or reorders the tool list', async () => {
  const { prompt } = await mount({ mode: 'danger-full-access' })
  const assembly = await prompt.assemble(CONTEXT)

  // Names and list order are part of the cached prefix on both providers.
  assert.deepEqual(assembly.tools.map((tool) => tool.name), SHELL_TOOLS.map((tool) => tool.name))
  assert.equal(assembly.tools.length, SHELL_TOOLS.length)
})
