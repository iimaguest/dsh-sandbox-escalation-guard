/**
 * The strictly-wider escalation ladder, as DSH defines it.
 *
 * This is the same table `@deepseek-ai/dsh-sandbox` exports and that
 * `approveEscalation` enforces: what a call whose effective mode is the KEY may
 * escalate TO. `read-only` is the floor; nothing escalates to it.
 *
 * It is mirrored here rather than imported so this package has NO runtime
 * dependency — it plugs into the host contract alone (`apply` + `inject`),
 * which is what lets it install from source without a peer-resolution step.
 *
 * A mirror can drift, so `test/wider-modes.test.mjs` compares this table
 * against the harness's own export whenever the harness happens to be
 * resolvable, and fails if they disagree. If you are reading this because that
 * test failed: update the table below to match `dsh-sandbox`.
 *
 * @module dsh-sandbox-escalation-guard/wider-modes
 */

export const WIDER_MODES = {
  'read-only': ['workspace-write', 'danger-full-access'],
  'workspace-write': ['danger-full-access'],
}
