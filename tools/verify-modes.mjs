/**
 * Print the model-facing bash schema for each session mode.
 *
 * This is the observable claim of the plugin, so it is reproducible rather than
 * described: it mounts the plugin against a real Cordis context and a real
 * `systemPrompt` registry, assembles a request the way the agent loop does, and
 * prints exactly which properties the model would be handed.
 *
 * Run: node tools/verify-modes.mjs
 *
 * Needs the harness resolvable (a DSH install, or this repo's devDependencies).
 * It is a diagnostic, not part of the test suite — the same assertions live in
 * `test/mount.test.mjs` and run without a harness present.
 */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'

import * as guard from '../lib/index.js'

/** The bash tool's escalation surface, built as dsh-tool-bash builds it. */
const ESCALATION_PROSE =
  ' Attempting a command the sandbox may deny is safe and expected: run it and read the marker.' +
  ' When a command is denied and a wider mode would let it succeed, escalate immediately in the same turn' +
  ' — retry with `sandbox_permissions` plus a one-sentence `justification`.'

const BASH = {
  name: 'bash',
  description: 'Execute a bash command (`bash -c`).' + ESCALATION_PROSE,
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

const MODES = ['danger-full-access', 'workspace-write', 'read-only']

for (const mode of MODES) {
  const ctx = new Context()
  const prompt = new SystemPrompt(ctx, {})
  prompt.tools(() => ({ schemas: [BASH], knownNames: ['bash'] }))

  await ctx.plugin({
    ...guard,
    apply: (scope) => guard.apply(scope, { warn: false, resolveMode: () => mode }),
  })

  // The caller arrives as `scope`; this is what assembleContextFor produces.
  const assembly = await prompt.assemble({ scope: { session: { id: 'verify' } } })
  const bash = assembly.tools.find((tool) => tool.name === 'bash')
  const properties = Object.keys(bash.parameters.properties)
  const enumValues = bash.parameters.properties.sandbox_permissions?.enum

  console.log(
    [
      mode.padEnd(20),
      `properties = [${properties.join(', ')}]`,
      `enum = ${enumValues ? JSON.stringify(enumValues) : 'ABSENT'}`,
      `escalation prose = ${/escalate immediately/.test(bash.description) ? 'PRESENT' : 'STRIPPED'}`,
    ].join('  '),
  )
}
