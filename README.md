# dsh-sandbox-escalation-guard

A permanent DeepSeek Harness plugin that stops the sandbox-escalation fields
being advertised to a model when the calling session cannot grant them.

It fixes a retry loop that GPT-family models fall into and that no amount of
prompting can break, because the model is being offered a field whose every
legal value is rejected.

---

## The bug

The DSH escalation fields — `sandbox_permissions` and `justification` — are
advertised from a **load-time capability fact** but judged at execution against
a **per-session policy fact**:

| | Source | Question answered |
|---|---|---|
| Advertisement | `ctx.shell.sandboxMode` | *Is a confining executor mounted?* |
| Execution | `ctx.sandboxPolicy.resolve().mode` | *What mode is this session actually in?* |

They disagree in exactly the case that hurts: a session sitting at the ceiling.

A session whose effective mode is `danger-full-access` is handed:

```json
"sandbox_permissions": {
  "type": "string",
  "enum": ["workspace-write", "danger-full-access"]
}
```

Both values are unusable. `workspace-write` is a **reduction**, and
`danger-full-access` is **the mode already in force** — and the check is
*strictly* wider, so neither can ever be granted. The system prompt
simultaneously instructs the model to use that field to "escalate immediately".

A model that fills in every optional property it is shown — the GPT family does
this — then cannot succeed and cannot tell why:

```
Error: invalid justification: expected a non-empty sentence
Error: sandbox escalation to "danger-full-access" is not strictly wider than this call's current "danger-full-access" mode
Error: sandbox escalation to "workspace-write" is not strictly wider than this call's current "danger-full-access" mode
```

Neither text names the only actual repair, which is to **omit both fields**. The
observed result is the same command retried until the turn dies.

### Evidence

From a live session (`oauth-codex/gpt-6-astra`, effective mode
`danger-full-access`, approval policy `never`), eight consecutive bash calls and
eight identical failures:

| model | tool calls | emitted `sandbox_permissions` | bash calls | bash + optional field |
|---|---|---|---|---|
| `zai/glm-5.3` | 211 | **0** | 86 | 48 |
| `oauth-codex/gpt-6-astra` | 10 | **8** | 8 | **8** |

Same session, same schema, same repo. The only variable is whether the model
completes optional properties — which is why this reads as "GPT is broken".

---

## What this plugin does

### 1. It stops publishing the impossible (the actual fix)

The tool set is still mutable at `system-prompt/assemble`, which is a
**sanctioned extension point** and runs per request, so the schema the model
will actually receive is rewritten against the *calling session's* effective
mode:

- keep only the enum values **strictly wider** than the current mode,
- when none remain, **remove both fields entirely**,
- and remove the escalation paragraph from the tool description that would
  otherwise keep urging the model to use fields that are no longer there.

It judges grantability by the same strictly-wider ladder
`@deepseek-ai/dsh-sandbox` exports and `approveEscalation` enforces, so the two
cannot disagree about what is grantable. That ladder is mirrored in
`lib/wider-modes.js` rather than imported, which is why this package has **no
runtime dependency** — it plugs into the host contract alone (`apply` +
`inject`). A `test/wider-modes.test.mjs` drift guard compares the mirror against
the harness's own export and fails if DSH ever changes the ladder.

For a `danger-full-access` session the model now receives a bash tool with only
`command` and `description`, and no escalation prose at all.

### 2. It corrects a call that carries them anyway

A client holding a cached schema, or a model that ignores its schema, can still
send an unusable request. `tools/pre-execute` then denies it with text that
names the effective mode, states that no value is grantable, and names the
repair — instead of the two opaque validations.

This is a fallback, not the mechanism. Once (1) is active a conforming model
never triggers it.

### The plugin never widens anything

It only stops offering modes that cannot be granted. It never grants a mode the
harness would have refused, and it cannot: it removes capability from the
advertised surface and adds none.

---

## Suppression matrix

| effective session mode | advertised enum | description prose |
|---|---|---|
| `danger-full-access` | *(fields removed)* | escalation paragraph removed |
| `workspace-write` | `["danger-full-access"]` | kept — a real escalation exists |
| `read-only` | `["workspace-write", "danger-full-access"]` | kept |
| unrecognised | *(fields removed)* | removed — fails closed |

An unrecognised mode grants nothing rather than everything: `SandboxMode` is a
validated closed union, so this cannot arise from a healthy host, and offering an
escalation would be the unsafe guess.

---

## Install

```bash
dsh plugin --profile web add github:iimaguest/dsh-sandbox-escalation-guard
```

That installs from GitHub, writes the dependency, and adds the profile's
`bundles` entry, so the `cordis.patch.yml` in this package mounts
automatically. Confirm the row:

```bash
grep -A 14 '"bundles"' ~/.dsh/profiles/web/package.json
```

**Activation is a profile load, not a file write.** The plugin takes effect when
the profile is next loaded.

### Managing the install

```bash
# pull new commits that have landed on GitHub
dsh plugin --profile web update dsh-sandbox-escalation-guard

# remove completely
dsh plugin --profile web remove dsh-sandbox-escalation-guard
```

To disable it without uninstalling, remove `dsh-sandbox-escalation-guard` from
the profile's `bundles` list. To develop against a local checkout instead of
GitHub, `dsh plugin --profile web add /path/to/dsh-sandbox-escalation-guard`.

## Configuration

```yaml
- id: dsh-sandbox-escalation-guard
  name: dsh-sandbox-escalation-guard
  config:
    warn: true          # log each intervention to the host console
    resolveMode: ...    # testing seam only; omit in production
```

| field | default | meaning |
|---|---|---|
| `warn` | `true` | Log when the schema is narrowed or a call is corrected. |
| `resolveMode` | *(unset)* | Overrides effective-mode resolution. Exists so the wiring can be tested without a live `sandboxPolicy`; production omits it and reads the session's own `sandbox/mode` fold. |

## Screenshots

![What the model is handed, before and after](assets/screenshots/01-before-after.png)

![Grantability by session mode](assets/screenshots/02-suppression-matrix.png)

![Where the guard sits](assets/screenshots/03-where-it-sits.png)

![Verified against the harness](assets/screenshots/04-verified.png)

These are diagrams of the harness's own contracts rather than captures of a UI,
and every value in them is copied from verified output — generating them is
`npm run screenshots`, and the mode table in the last image is exactly what
`npm run verify` prints.

## Reproducing the claim

```bash
npm install
npm run verify
```

Mounts the plugin against a real Cordis context and a real `systemPrompt`
registry and prints the model-facing bash schema for each session mode — the
plugin's observable claim, reproducible rather than described.

## Tests

```bash
npm test
```

28 tests:

- **`test/guard.test.mjs`** — the suppression matrix, the strictly-wider table
  against `approveEscalation`'s judgement, and prose stripping.
- **`test/wider-modes.test.mjs`** — drift guard: the mirrored ladder is compared
  against `@deepseek-ai/dsh-sandbox`'s own export whenever the harness is
  resolvable, and skipped (not failed) when it is not.
- **`test/mount.test.mjs`** — the plugin applied to a real Cordis context and a
  real `systemPrompt` registry, asserting what the model would be handed, that a
  confined session still receives the field it can use, that unmounting restores
  the original surface exactly (so this is an ordinary plugin row with no
  residue), and that the pre-execute correction fires only on unusable requests.

The escalation-prose fixtures in `guard.test.mjs` are copied verbatim from the
shipped `dsh-tool-bash` and `dsh-tool-fs` descriptions. If a DSH upgrade reworks
that wording, the prose tests fail loudly rather than this package silently
ceasing to strip prose.

---

## Known limits

**It cannot repair the schema's origin.** This plugin rewrites the schema on its
way to the model; it does not change `dsh-tool-bash` or `dsh-tool-fs`. The
underlying predicate — advertising from `ctx.shell.sandboxMode` while validating
against `ctx.sandboxPolicy.resolve()` — remains the harness's own, and the
correct upstream fix is to gate the fields on the session's resolved mode (and
to accept the current mode as a no-op). This plugin is the durable workaround
for an install that must not patch `node_modules`.

**Prose stripping is anchored, not structural.** The escalation paragraph is
removed by matching its leading clause. If a future DSH rewrites that text the
schema fix still applies and only the prose is left behind — the model keeps its
instructions but loses the fields they refer to. The pinned tests make that
visible.

**The pre-execute fallback denies rather than executes.** Letting the call
proceed by stripping the arguments would require re-implementing tool
dispatching, because `exec.arguments` is deep-frozen before any plugin
observes it. A denial that names the repair is the safe choice; with (1) active
it should never fire.

## License

Apache-2.0
