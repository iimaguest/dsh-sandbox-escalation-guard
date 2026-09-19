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
