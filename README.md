# dsh-sandbox-escalation-guard

A DeepSeek Harness plugin that stops the sandbox-escalation fields being offered
to a model when the calling session cannot grant them.

**It fixes a GPT-specific failure.** GPT-family models complete every optional
property in a tool's schema, and the two optional properties on `bash`, `write`
and `edit` are exactly the two a full-access session can never use. So GPT fills
them in on every call, every call is rejected before it runs, and the error text
never says that the fix is to omit them. The turn dies with nothing executed.

A model that sends only what a call needs never sees this — which is why it
looks like "GPT is broken" while other models are fine in the same session. The
fix is not a better prompt: it is to stop publishing fields that cannot be
filled. See [why this presents as GPT-specific](#why-this-presents-as-gpt-is-broken).

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

### Why this presents as "GPT is broken"

Nothing here is model-specific in the harness. The difference is a habit, and it
collides with this defect perfectly:

**GPT-family models populate every optional property in a tool's schema.** Given
`command` (required) plus `sandbox_permissions` and `justification` (optional),
they do not send the minimum the call needs — they send a fully-formed instance
of the schema they were shown. Asked for one string, they fill in three.

That habit is usually harmless. Here it is fatal, because the two optional
properties are the exact two that a full-access session can never use. So the
model helpfully completes them on **every** call, each call is rejected before
anything runs, and the error text points at the justification field rather than
at the real instruction, which is to leave the fields out. Retrying with the
same habit produces the same rejection. The turn ends with no command executed
and no usable signal about why.

A model that only sends what the call needs never touches those fields and never
sees the bug. From the outside, that looks like one model being broken — same
session, same harness, same repository, different models, only one of them
failing.

The fix follows directly from the diagnosis: **if the model completes whatever
it is shown, stop showing it things it cannot use.** Once both fields are gone
from the schema, there is nothing left for the habit to complete, and the
failure mode disappears for the model that was most prone to it — without the
model needing to know it existed, and without a prompt telling it to be careful,
which is the kind of instruction a schema-completing model is least likely to
reliably follow.

This is why the primary fix is suppression rather than a clearer error message.
A better message asks the model to behave differently; removing the field does
not depend on the model's cooperation at all. The `tools/pre-execute`
correction exists only for the residual case — a cached schema, or a model that
ignores the schema it was given.

### Evidence

From one live session (effective mode `danger-full-access`, approval policy
`never`), comparing a model that completes optional properties against one that
does not:

| model | tool calls | emitted `sandbox_permissions` | bash calls | bash + optional field |
|---|---|---|---|---|
| `zai/glm-5.3` | 211 | **0** | 86 | 48 |
| `oauth-codex/gpt-6-astra` | 10 | **8** | 8 | **8** |

The GLM column is not "a model that tried and succeeded" — it emitted the field
**zero** times in 211 calls. It never entered the failure mode, because it sends
only the properties a call needs. The GPT column emitted it on **every** bash
call and lost all eight to the same rejection.

Same session, same schema, same repository, same effective mode. The only
variable is whether the model completes the optional properties it was shown —
which is why this reads from the outside as "GPT is broken" rather than as a
schema defect that one model's habits expose.

Confirmed at the wire level too: the `request/header` event for that session
shows `bash`, `write` and `edit` each advertising `sandbox_permissions` with
`enum: ["workspace-write","danger-full-access"]`, so the field was genuinely
published to the model rather than being something it invented.

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

### Staying put, and narrowing, are the same case

There is no separate handling for a model trying to *reduce* its own permissions,
because the predicate never had a direction. `approveEscalation` accepts a value
only when it is strictly wider than the one in effect, so **every** non-wider
value is unusable — the mode already in force, and every mode below it alike.
Neither is published:

| effective mode | `read-only` requested | `workspace-write` requested | `danger-full-access` requested |
|---|---|---|---|
| `read-only` | offered | offered | offered |
| `workspace-write` | **not offered**, denied | not offered | offered |
| `danger-full-access` | **not offered**, denied | **not offered**, denied | not offered, denied |

At `workspace-write` the enum is reduced to `["danger-full-access"]`, so
`read-only` is simply absent from the schema. At `danger-full-access` there is no
enum at all. A call that carries a reduction anyway — a cached schema, or a model
ignoring its schema — is denied at `tools/pre-execute` with the same correction
text, which names the effective mode as already the widest and states that no
value is grantable, so the repair is to omit both fields.

Narrowing is not something this field could ever express in the first place: a
session's mode is set by policy, not requested downward. The guard does not
invent a mechanism for it — it stops the field from being offered as though it
were one.

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

40 tests:

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
  Three of these mount the plugin **before** the policy service exists and then
  provide it, which is the real boot order — see the note below. Others mount
  neighbouring listeners on both sides of the guard, and re-assemble fifty times
  per mode to prove the output bytes never move.

### The waterfall must be chained

`ctx.waterfall` dispatches through a chained thunk — `(cbs.shift() ?? inner)` —
so a listener that returns **without calling `next()` ends the chain** for every
listener registered after it. The first version of this plugin did exactly that,
which silently suppressed the `system-prompt/assemble` listeners of
`dsh-session-reference` and `dsh-agent` for the whole process. Their
contributions never reached a request and nothing reported the loss; it was
found by probing the dispatcher against two listeners, not by any single-listener
test. The listener now `await`s `next()` and narrows the result, which is also
the correct order — the model must receive the *final* assembly.

### The service-ordering trap

`ctx.get('sandboxPolicy')` must not be read once inside `apply` and closed over.
A bundle patch is appended to the composition, while `sandbox-policy` sits
earlier in the base tree and is provided asynchronously, so the row can load
before the service exists. Closing over the result binds `undefined` and the
plugin then narrows nothing for the entire session — silently, having printed a
warning that looks like a missing dependency rather than a race.

Declaring `sandboxPolicy` in `inject` is the other wrong answer: it defers
`apply` until the service appears, so on a composition that genuinely lacks it
the plugin waits out the session with no hooks registered and no diagnostic at
all. The guard resolves the service per request instead, mounts unconditionally,
and reports a genuinely absent service once, at the first request it cannot
serve. `mount.test.mjs` pins both halves: untouched before the service arrives,
narrowing immediately after.

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

**A listener registered after this one can still re-add the fields.** The
guard narrows the assembly returned by `next()`, which carries the work of every
listener *upstream* of it in the chain. A plugin that appends tool schemas and
happens to register after this one would put un-narrowable fields back.
Middleware order is absolute and cannot be corrected from inside the waterfall.
This does not arise with the shipped set: `dsh-session-reference` and
`dsh-agent` both call `next()` and only read `assembly.variables`, adding no
tools.

## On prompt caching

The guard rewrites request content, which is the exact shape of change that can
quietly destroy a provider's prefix cache. So this is measured against what the
providers actually document, not assumed.

### What the providers say

| Provider | Rule |
|---|---|
| [OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching) | Changing `tools` changes "names, descriptions, schemas, **ordering**, or tool-specific instructions". Cache reuse "requires the entire rendered prefix to match". The cache-routing hash is taken over the initial tokens "**including tool definitions when present**". |
| [Anthropic](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching) | The hierarchy is `tools → system → messages`; "Modifying tool definitions" invalidates the **entire** cache at every level. |
| [DeepSeek](https://api-docs.deepseek.com/guides/kv_cache/) | Caching is automatic and disk-based; a request hits only by **fully matching** a persisted cache prefix unit. |

All three agree on the operative point: tool definitions sit at the front of the
prefix, so they must be byte-stable for reuse to happen at all.

### Why this plugin satisfies it

**The bytes are constant for the length of a session.** The effective mode is a
session fact, so `narrowTools` yields identical output on every assembly. The
schema is narrowed *once*, in effect, and every later turn sends the same bytes.
The cache is written on the first request and read thereafter — unaffected in
steady state.

**Nothing varying is introduced.** No timestamp, counter, identifier, token or
regeneration enters the output, so the routing hash is stable too.

**Neither name nor order changes.** Only `properties` entries and the
description text are filtered; the tool list keeps its order and every tool keeps
its name. Property insertion order is preserved from the input, so a rewrite
never reorders keys and changes bytes without changing meaning.

**The result never depends on request history.** Rendering a given mode produces
the same bytes whether it is the first request or the hundredth.

**It makes the cached prefix smaller, not different.** The escalation fields are
removed rather than rewritten, so the published definition is a strict subset of
the original.

### What is pinned by tests

`test/mount.test.mjs` asserts the contract directly:

- 50 consecutive assemblies per mode produce exactly **one** distinct
  `JSON.stringify` of the tool surface;
- the same mode renders identically no matter where it falls in a sequence of
  differing modes;
- tool names and list order survive narrowing;
- property key order survives narrowing.

### The one honest exception

A genuine mid-session mode change — the user switching the session's sandbox
mode — legitimately changes the schema, and the prefix from that point must be
recomputed. That is a real change in what the model may request, so it is correct
for the cache to follow it. The guard does not, and should not, try to hide it.
Note also that the pre-execute correction (a denial) is a *message*, appended at
the end of the conversation, so it cannot invalidate anything already cached
ahead of it.

## License

Apache-2.0
