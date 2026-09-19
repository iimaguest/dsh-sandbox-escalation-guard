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
 * dsh-sandbox-escalation-guard — host half.
 *
 * WHY THIS EXISTS
 *
 * The DSH sandbox-escalation fields (`sandbox_permissions` + `justification`)
 * are advertised from a LOAD-TIME capability fact — "is a confining executor
 * mounted?" (`ctx.shell.sandboxMode`) — but are judged at EXECUTION against a
 * PER-SESSION fact — the effective mode resolved from that session's
 * `sandbox/mode` fold (`ctx.sandboxPolicy.resolve()`).
 *
 * The two disagree in exactly one direction that matters: a session sitting at
 * the ceiling. With an effective mode of `danger-full-access` the advertised
 * enum is `["workspace-write", "danger-full-access"]`, and BOTH values are
 * unusable — `workspace-write` is a reduction and `danger-full-access` is the
 * mode already in force, so neither is "strictly wider". The model is handed a
 * field whose every legal value is rejected, and the task's tool description
 * simultaneously instructs it to use that field to "escalate immediately".
 *
 * A model that fills in every optional property it is shown — GPT-family
 * routes do this; `zai/glm-5.3` sent 0 escalation arguments in 211 calls in the
 * session this was written from, `oauth-codex/gpt-6-astra` sent them in 8 of 8
 * bash calls — then cannot succeed and cannot tell why, because both failure
 * texts describe a malformed or non-widening request rather than naming the
 * only repair: omit the fields. The observed result is a same-command retry
 * loop.
 *
 * WHAT THIS PLUGIN DOES
 *
 *  1. Primary — stop advertising the impossible. At `system-prompt/assemble`
 *     the tool set is still mutable, so the schema the model will actually
 *     receive is rewritten per request against the CALLING SESSION's effective
 *     mode: the enum keeps only modes strictly wider than the current one, and
 *     when none remain the two fields are removed entirely, along with the
 *     escalation paragraph in the tool description that would otherwise keep
 *     urging the model to use them.
 *
 *  2. Secondary — tolerate a call that carries them anyway. A client that
 *     cached an older schema, or a model that ignores its schema, can still
 *     send an unusable escalation request; `tools/pre-execute` then denies it
 *     with text that names the repair instead of the harness's two opaque
 *     validations.
 *
 * The plugin never widens anything. It only stops offering modes that cannot
 * be granted, and it never grants a mode the harness would have refused.
 *
 * @module dsh-sandbox-escalation-guard
 */

import { WIDER_MODES } from './wider-modes.js'

export const name = 'sandbox-escalation-guard'
export const inject = ['systemPrompt']

/** The escalation fields as the harness spells them. */
const FIELD_MODE = 'sandbox_permissions'
const FIELD_REASON = 'justification'

/**
 * The two descriptions that carry escalation guidance, anchored on their
 * stable leading clause. `dsh-tool-bash` builds one; `dsh-tool-fs` builds the
 * other and shares it across `write` and `edit`. Only the leading clause is
 * matched — a JS regex literal carries no `g` flag state, so a probe and the
 * real strip cannot disagree about `lastIndex`.
 */
const ESCALATION_PROSE_PATTERNS = [
  /Attempting a command the sandbox may deny is safe and expected:.*$/s,
  /Attempting an operation the sandbox may deny is safe and expected:.*$/s,
]

/**
 * The sentence that names the field, used only to decide whether stripping the
 * schema also requires stripping prose. If the deployment reworks the
 * description such that neither anchor matches, the schema fix still applies
 * and only the prose is left behind.
 */
const ESCALATION_NAMED = new RegExp(FIELD_MODE)

/**
 * Tool parameters are declared as `{ type, ... }` specs; the identity check
 * only needs to recognise the pair, not validate it.
 */
function hasEscalationFields(parameters) {
  const properties = parameters?.properties
  return properties?.[FIELD_MODE] !== undefined && properties?.[FIELD_REASON] !== undefined
}

/**
 * Drop the escalation paragraph from one description. Returns the text
 * unchanged when no anchor matches, so an unrecognised description degrades to
 * the schema-only fix rather than losing unrelated guidance.
 * @param description - the tool description as assembled.
 * @returns the description without escalation guidance.
 */
export function stripEscalationProse(description) {
  if (typeof description !== 'string' || !ESCALATION_NAMED.test(description)) return description
  let text = description
  for (const pattern of ESCALATION_PROSE_PATTERNS) text = text.replace(pattern, '')
  return text.trim().length === 0 ? description : text.trimEnd()
}

/**
 * Every mode a call in `mode` may still escalate TO — the harness's own
 * strictly-wider table, so this plugin and `approveEscalation` can never
 * disagree about what is grantable. `danger-full-access` is absent because it
 * is the ceiling: nothing is strictly wider than it.
 * @param mode - the effective mode of the calling session.
 * @returns the still-grantable escalation targets (empty at the ceiling).
 */
export function widerModesFor(mode) {
  return WIDER_MODES[mode] ?? []
}

/**
 * Restrict one tool's escalation enum to the modes the calling session can
 * actually grant, dropping both fields when none remain. Returns the SAME
 * object when nothing changes, so an unaffected request is never presented as
 * a changed tool surface.
 *
 * `justification` is dropped together with `sandbox_permissions` in every case:
 * the harness validates the pair, so an orphan reason is itself a malformed
 * ask.
 *
 * @param tool - one assembled tool schema `{ name, description, parameters }`.
 * @param grantable - the strictly-wider modes for the calling session.
 * @returns the tool, narrowed when escalation is not fully available.
 */
export function narrowTool(tool, grantable) {
  if (!hasEscalationFields(tool?.parameters)) return tool
  const declared = tool.parameters.properties[FIELD_MODE]?.enum
  const allowed = Array.isArray(declared) ? declared.filter((mode) => grantable.includes(mode)) : []
  const unchanged = allowed.length === declared?.length && allowed.length === grantable.length
  if (unchanged) return tool

  const properties = { ...tool.parameters.properties }
  if (allowed.length === 0) {
    delete properties[FIELD_MODE]
    delete properties[FIELD_REASON]
  } else {
    properties[FIELD_MODE] = { ...properties[FIELD_MODE], enum: allowed }
  }

  return {
    ...tool,
    description: allowed.length === 0 ? stripEscalationProse(tool.description) : tool.description,
    parameters: { ...tool.parameters, properties },
  }
}

/**
 * Rewrite an assembled tool list for one session. Pure, so it is directly
 * testable and safe to run on every assembly.
 * @param tools - the assembled tool schemas.
 * @param mode - the calling session's effective sandbox mode, when known.
 * @returns the tool list to publish.
 */
export function narrowTools(tools, mode) {
  if (!Array.isArray(tools) || mode === undefined) return tools
  const grantable = widerModesFor(mode)
  let changed = false
  const next = tools.map((tool) => {
    const narrowed = narrowTool(tool, grantable)
    if (narrowed !== tool) changed = true
    return narrowed
  })
  return changed ? next : tools
}

/**
 * The denial text for a call that still carries an unusable escalation
 * request. Names the effective mode and the exact repair, because that is the
 * information both harness validation messages withhold.
 * @param requested - the mode the call asked for.
 * @param effective - the mode the session is actually in.
 * @returns the model-facing correction.
 */
export function escalationCorrection(requested, effective) {
  const grantable = widerModesFor(effective)
  const options = grantable.length > 0 ? grantable.join(' or ') : 'none'
  return [
    `sandbox escalation to "${requested}" is not available in this session: the effective mode is already "${effective}",`,
    `so the only modes this call could escalate to are: ${options}.`,
    `Retry the exact same call with \`${FIELD_MODE}\` and \`${FIELD_REASON}\` omitted — the call will run at the session's standing mode.`,
    `Do not retry with a different value of \`${FIELD_MODE}\`; no value is grantable here.`,
  ].join(' ')
}

/** Tool arguments carrying an escalation request, or undefined when absent. */
function requestedModeOf(exec) {
  const args = exec?.arguments
  if (args === null || typeof args !== 'object') return undefined
  const requested = args[FIELD_MODE]
  return typeof requested === 'string' ? requested : undefined
}

/**
 * Whether a call's escalation request is unusable and must be corrected.
 * Exported so the guard's decision is testable without a live registry.
 * @param requested - the mode the call asked for.
 * @param effective - the session's effective mode.
 * @returns whether the request cannot be granted.
 */
export function isUnusableEscalation(requested, effective) {
  return !widerModesFor(effective).includes(requested)
}

export function apply(ctx, config = {}) {
  const warn = config.warn ?? true
  /**
   * Resolve the policy service per request rather than once at mount.
   *
   * Reading `ctx.get('sandboxPolicy')` inside `apply` and closing over it binds
   * `undefined` whenever this row happens to mount before the policy service
   * materialises — which is the normal case here, because a bundle patch is
   * appended to the composition while `sandbox-policy` sits earlier in the base
   * tree and is provided asynchronously. The plugin would then load, register
   * its listeners, and silently narrow nothing forever.
   *
   * Declaring `sandboxPolicy` in `inject` would defer `apply` instead, but it
   * trades a wrong answer for no answer: on a composition that genuinely lacks
   * the service the plugin would wait out the whole session with no hooks
   * registered and no diagnostic. Looking it up lazily keeps this plugin
   * mounting unconditionally, and lets it start working the moment the service
   * appears.
   */
  const policyOf = () => ctx.get('sandboxPolicy')

  /**
   * Build the effective-mode resolver once per mount. An explicit
   * `config.resolveMode` wins so the wiring can be exercised without a live
   * policy service; otherwise the session's own `sandbox/mode` fold is read
   * through `ctx.sandboxPolicy`.
   *
   * The assembly context carries the caller as `scope` (the agent itself);
   * `agent` is accepted too, so a hand-built context behaves.
   */
  const resolveMode = typeof config.resolveMode === 'function'
    ? config.resolveMode
    : (context) => {
      const policy = policyOf()
      if (policy === undefined) return undefined
      const session = (context?.scope ?? context?.agent)?.session
      if (session === undefined) return undefined
      return policy.resolve({ session }).mode
    }

  /**
   * Warn once, at the first request the guard cannot serve, rather than at
   * mount. A mount-time warning here would be wrong in both directions: it
   * fires during the ordinary startup race in which the service has simply not
   * arrived yet, and it stays silent afterwards if the service never appears at
   * all.
   */
  let warnedMissingPolicy = false
  const noteMissingPolicy = () => {
    if (!warn || warnedMissingPolicy) return
    warnedMissingPolicy = true
    console.warn(
      '[sandbox-escalation-guard] ctx.sandboxPolicy is unavailable, so escalation schemas cannot be ' +
        'narrowed per session and are being left untouched. Mount @deepseek-ai/dsh-sandbox-policy in the ' +
        'same composition as this plugin.',
    )
  }

  /**
   * Whether an escalation could be approved AT ALL in the calling session.
   *
   * This is the decision the published surface is keyed on, and it is
   * deliberately a SESSION fact rather than the current access level:
   *
   *  - `ApprovalService.decide` returns `"rejected"` when the session's effective
   *    policy is `never`, BEFORE consulting any approver. Under that policy an
   *    escalation is impossible in every mode, so the fields can be removed
   *    uniformly and the result is byte-identical whichever mode is in force.
   *  - Keying the rewrite on the mode instead made the tools block move whenever
   *    the user switched access level. The tools block is the FRONT of the cached
   *    prefix, so that discarded the entire cached conversation behind it — a
   *    manufactured cache miss, priced at many times the cost of a hit.
   *
   * Every uncertain case keeps the surface as the harness built it. We rewrite
   * only when the harness itself says the escalation can never be granted.
   *
   * @param context - the assembly context carrying the calling agent/session.
   * @returns true when an escalation might still be approvable.
   */
  const escalationPossible = (context) => {
    if (config.escalationPossible !== undefined) return config.escalationPossible
    const approval = ctx.get('approval')
    // No approval service at all: there is no channel to grant one, but there is
    // also nothing asserting it is impossible. Leave the surface alone.
    if (approval === undefined) return true
    const session = (context?.scope ?? context?.agent)?.session
    if (session === undefined) return true
    const policy = typeof approval.effectivePolicy === 'function'
      ? approval.effectivePolicy(session)
      : undefined
    // Only a definite `never` licenses removal.
    return policy !== 'never'
  }

  /**
   * Rewrite the assembled tool surface for the calling session.
   *
   * `next` must be called: the waterfall is a chained thunk
   * (`cbs.shift() ?? inner`), so a listener that returns without calling it
   * ENDS the chain. This listener used to do exactly that, which silently
   * suppressed every later `system-prompt/assemble` listener in the process —
   * `dsh-session-reference` and `dsh-agent` among the shipped ones. Their
   * contributions never reached a request, and nothing reported it.
   *
   * Calling `next()` first and narrowing the result is also the correct order:
   * what the model receives must be the final assembly, after every other
   * listener has had its say about the tool surface.
   */
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    let settled
    try {
      settled = await next()

      const hasTools = (value) => Array.isArray(value?.tools) && value.tools.length > 0
      // Narrow the chain's own result when it produced one, so the model sees a
      // surface derived from the FINAL assembly. If the chain produced nothing,
      // fall back to the tools this listener was handed: the rewrite depends only
      // on the tool list plus a session fact, so it stays correct even when the
      // rest of the assembly never materialised.
      const source = hasTools(settled) ? settled : hasTools(assembly) ? assembly : undefined
      if (source === undefined) return settled ?? assembly

      if (escalationPossible(context)) return settled
      // The session can never have an escalation approved: strip the fields in
      // EVERY mode. Byte-identical whichever mode is in force, so no
      // access-level switch can move the cached prefix.
      const tools = narrowTools(source.tools, 'danger-full-access')
      if (tools === source.tools) return settled
      return source === settled ? { ...settled, tools } : { ...assembly, tools }
    } catch (error) {
      // Never break a model request over an advisory schema rewrite, and never
      // drop downstream work: fall back to whatever the chain produced, and to
      // the raw input only if the chain itself never returned.
      console.error('[sandbox-escalation-guard] schema narrowing failed', error)
      return settled ?? assembly
    }
  })

  ctx.on('tools/pre-execute', (exec, next) => {
    try {
      const requested = requestedModeOf(exec)
      if (requested === undefined) return next()
      const effective = resolveMode({ scope: exec.agent, agent: exec.agent })
      if (effective === undefined) {
        if (policyOf() === undefined) noteMissingPolicy()
        return next()
      }
      if (!isUnusableEscalation(requested, effective)) return next()
      if (warn) {
        console.warn(`[sandbox-escalation-guard] ${exec.name} requested sandbox escalation to "${requested}" while already in "${effective}" — corrected`)
      }
      return Promise.resolve({ kind: 'deny', reason: escalationCorrection(requested, effective) })
    } catch (error) {
      console.error('[sandbox-escalation-guard] escalation guard failed', error)
      return next()
    }
  })
}
