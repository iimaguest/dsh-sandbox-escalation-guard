/**
 * Print the model-facing bash schema for every (policy, access level) pair.
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
 * `test/mount.test.mjs` and `test/real-services.test.mjs`.
 *
 * The column that matters is the last one. The tools block is the FRONT of the
 * cached prompt prefix, so if it changed with the access level, every mode
 * switch would discard the entire cached conversation behind it. Each policy
 * block therefore prints whether its four rows are byte-identical.
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

const MODES = ['read-only', 'workspace-write', 'danger-full-access']
const POLICIES = ['never', 'ask']

for (const policy of POLICIES) {
  const serializations = new Set()

  for (const mode of MODES) {
    const ctx = new Context()
    const prompt = new SystemPrompt(ctx, {})
    prompt.tools(() => ({ schemas: [BASH], knownNames: ['bash'] }))

    await ctx.plugin({
      ...guard,
      // `escalationPossible` stands in for the approval service's verdict, which
      // is what the plugin reads in a real host: `false` is exactly the answer
      // for a `never` policy.
      apply: (scope) => guard.apply(scope, { warn: false, escalationPossible: policy !== 'never' }),
    })

    // The caller arrives as `scope`; this is what assembleContextFor produces.
    const assembly = await prompt.assemble({ scope: { session: { id: 'verify' } } })
    const bash = assembly.tools.find((tool) => tool.name === 'bash')
    const properties = Object.keys(bash.parameters.properties)
    const enumValues = bash.parameters.properties.sandbox_permissions?.enum

    serializations.add(JSON.stringify(assembly.tools))

    console.log(
      [
        `policy=${policy}`.padEnd(13),
        mode.padEnd(20),
        `properties = [${properties.join(', ')}]`,
        `enum = ${enumValues ? JSON.stringify(enumValues) : 'ABSENT'}`,
        `prose = ${/escalate immediately/.test(bash.description) ? 'PRESENT' : 'STRIPPED'}`,
      ].join('  '),
    )
  }

  const stable = serializations.size === 1
  console.log(
    `  -> published surface ${stable ? 'IDENTICAL' : 'MOVED'} across all three access levels` +
      (stable ? ' (no cache invalidation on a mode change)' : ' — THIS IS A CACHE MISS'),
  )
  console.log()
}
