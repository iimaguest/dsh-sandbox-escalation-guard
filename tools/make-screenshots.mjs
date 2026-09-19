/**
 * Build the storefront screenshots as SVG, then rasterize with rsvg-convert.
 *
 * Every value drawn here is copied from real, verified output of the plugin —
 * the property lists, the enums, the assembled/authoritative halves of the
 * waterfall, and the wiring in `apply`. Nothing is a mock-up of a UI that does
 * not exist: these are diagrams of the harness's own contracts, so they stay
 * true as long as the tests pass.
 *
 * Run: node tools/make-screenshots.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'assets', 'screenshots')
const W = 1200

const FONT = "Menlo, 'DejaVu Sans Mono', monospace"
const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif"

const C = {
  bg: '#0b0f14',
  panel: '#121821',
  panelEdge: '#1e2733',
  rule: '#243040',
  text: '#e6edf3',
  dim: '#8b98a5',
  faint: '#5b6673',
  green: '#3fb950',
  red: '#f85149',
  amber: '#d29922',
  blue: '#58a6ff',
  purple: '#bc8cff',
  add: '#1f3d2b',
  del: '#3d1f22',
}

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** One line of text. */
const t = (x, y, s, { fill = C.text, size = 15, font = FONT, weight = 400, anchor = 'start', op = 1 } = {}) =>
  `<text x="${x}" y="${y}" fill="${fill}" font-family="${font}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" opacity="${op}">${esc(s)}</text>`

const rect = (x, y, w, h, { fill = 'none', stroke = 'none', rx = 0, sw = 1, op = 1 } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${op}"/>`

/** A code panel with an optional title strip. */
const panel = (x, y, w, h, title, accent = C.rule) => {
  const head = title
    ? rect(x, y, w, 40, { fill: '#161d27', rx: 0 }) +
      t(x + 18, y + 26, title, { size: 13, fill: C.dim, weight: 600 }) +
      rect(x, y + 40, w, 1, { fill: C.rule }) +
      rect(x, y, w, 3, { fill: accent })
    : ''
  return rect(x, y, w, h, { fill: C.panel, stroke: C.panelEdge, rx: 10, sw: 1 }) + head
}

/** A row of monospace key/value pairs, as a schema listing. */
function listing(x, y, rows, { size = 14, lh = 24, colAt = 196 } = {}) {
  return rows
    .map((r, i) => {
      const yy = y + i * lh
      return t(x, yy, r[0], { size, fill: r[2] ?? C.dim }) + t(x + colAt, yy, r[1], { size, fill: r[3] ?? C.text })
    })
    .join('')
}

const svg = (h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}">` +
  `<rect width="${W}" height="${h}" fill="${C.bg}"/>${body}</svg>`

// ---------------------------------------------------------------- screenshot 1
function shotComparison() {
  const H = 790
  let b = ''

  b += t(64, 72, 'What the model is handed', { size: 30, weight: 700, font: SANS })
  b += t(64, 104, 'bash tool schema, assembled per request · danger-full-access session', { size: 15, fill: C.dim, font: SANS })

  const colW = 512
  const left = 64
  const right = 64 + colW + 48
  const top = 140
  const cardH = 366

  // BEFORE
  b += panel(left, top, colW, cardH, 'WITHOUT THE GUARD', C.red)
  b += t(left + 22, top + 78, 'properties:', { size: 14, fill: C.dim })
  b += listing(left + 22, top + 106, [
    ['  command', '"type": "string"'],
    ['  sandbox_permissions', '"type": "string"', C.text, C.text],
    ['', 'enum: [', C.dim, C.dim],
    ['', '  "workspace-write",', C.amber, C.amber],
    ['', '  "danger-full-access"', C.amber, C.amber],
    ['', ']', C.dim, C.dim],
    ['  justification', '"type": "string"'],
  ])
  b += rect(left + 22, top + 290, colW - 44, 1, { fill: C.rule })
  b += t(left + 22, top + 320, 'both values rejected at execution:', { size: 13, fill: C.dim })
  b += t(left + 22, top + 342, 'not strictly wider than this', { size: 13, fill: C.red })

  // AFTER
  b += panel(right, top, colW, cardH, 'WITH THE GUARD', C.green)
  b += t(right + 22, top + 78, 'properties:', { size: 14, fill: C.dim })
  b += listing(right + 22, top + 106, [['  command', '"type": "string"']])
  b += rect(right + 22, top + 290, colW - 44, 1, { fill: C.rule })
  b += t(right + 22, top + 320, 'both fields removed, and', { size: 13, fill: C.green })
  b += t(right + 22, top + 342, 'the prose urging them too', { size: 13, fill: C.green })

  // footnote
  b += rect(64, 552, W - 128, 1, { fill: C.rule })
  b += t(64, 588, 'Advertised from a load-time fact, validated against a per-session one.', { size: 14, fill: C.text, font: SANS })
  b += t(64, 614, 'They disagree at the ceiling, so the field is offered exactly where it can never be granted.', { size: 14, fill: C.dim, font: SANS })
  b += t(64, 662, 'zai/glm-5.3', { size: 13, fill: C.faint, font: SANS })
  b += t(240, 662, '211 calls, 0 escalation attempts', { size: 13, fill: C.green, font: SANS })
  b += t(64, 688, 'gpt-6-astra', { size: 13, fill: C.faint, font: SANS })
  b += t(240, 688, '8 of 8 bash calls attempted it, all 8 failed', { size: 13, fill: C.red, font: SANS })
  b += t(64, 730, 'Same schema, same repository. The only variable is whether a model completes optional properties.', { size: 13, fill: C.faint, font: SANS })

  return svg(H, b)
}

// ---------------------------------------------------------------- screenshot 2
function shotMatrix() {
  const H = 700
  let b = ''
  b += t(64, 72, 'Grantability, by session mode', { size: 30, weight: 700, font: SANS })
  b += t(64, 104, 'The ladder is the one approveEscalation enforces; a drift-guard test fails if it ever changes.', { size: 15, fill: C.dim, font: SANS })

  const rows = [
    ['danger-full-access', 'fields removed', 'prose removed', C.red],
    ['workspace-write', '["danger-full-access"]', 'prose kept', C.amber],
    ['read-only', '["workspace-write", "danger-full-access"]', 'prose kept', C.green],
    ['unrecognised mode', 'fields removed', 'prose removed', C.red],
  ]

  const x = 64
  const y = 150
  const w = W - 128
  const rh = 62

  b += t(x + 24, y - 14, 'EFFECTIVE SESSION MODE', { size: 12, fill: C.faint, weight: 700, font: SANS })
  b += t(x + 320, y - 14, 'ADVERTISED ENUM', { size: 12, fill: C.faint, weight: 700, font: SANS })
  b += t(x + 760, y - 14, 'ESCALATION PROSE', { size: 12, fill: C.faint, weight: 700, font: SANS })

  rows.forEach((r, i) => {
    const yy = y + i * rh
    b += rect(x, yy, w, rh - 6, { fill: C.panel, stroke: C.panelEdge, rx: 8 })
    b += rect(x, yy, 3, rh - 6, { fill: r[3] })
    b += t(x + 24, yy + 34, r[0], { size: 15, fill: C.text })
    b += t(x + 320, yy + 34, r[1], { size: 14, fill: r[2] === 'prose kept' && r[1].startsWith('fields') ? C.red : r[3] })
    b += t(x + 760, yy + 34, r[2], { size: 14, fill: r[2] === 'prose removed' ? C.dim : C.amber })
  })

  b += rect(64, 458, W - 128, 1, { fill: C.rule })
  b += t(64, 496, 'The guard never widens anything.', { size: 17, weight: 700, fill: C.text, font: SANS })
  b += t(64, 524, 'It removes capability from the advertised surface and adds none: a mode the harness would have', { size: 14, fill: C.dim, font: SANS })
  b += t(64, 548, 'refused is no longer offered, and a mode it would have granted still is.', { size: 14, fill: C.dim, font: SANS })
  b += t(64, 596, 'An unrecognised mode fails closed — it grants nothing rather than everything, because offering an', { size: 13, fill: C.faint, font: SANS })
  b += t(64, 618, 'escalation would be the unsafe guess.', { size: 13, fill: C.faint, font: SANS })

  return svg(H, b)
}

// ---------------------------------------------------------------- screenshot 3
function shotWiring() {
  const H = 700
  let b = ''
  b += t(64, 72, 'Where the guard sits', { size: 30, weight: 700, font: SANS })
  b += t(64, 104, 'A Cordis plugin row with two hooks, no runtime dependency, and no residue when unmounted.', { size: 15, fill: C.dim, font: SANS })

  // flow
  const cy = 176
  const box = (x, w, label, sub, accent) => {
    return (
      rect(x, cy, w, 92, { fill: C.panel, stroke: C.panelEdge, rx: 10, sw: 1 }) +
      rect(x, cy, w, 3, { fill: accent }) +
      t(x + w / 2, cy + 40, label, { size: 14, weight: 700, anchor: 'middle', font: SANS }) +
      t(x + w / 2, cy + 64, sub, { size: 12, fill: C.dim, anchor: 'middle' })
    )
  }
  const arrow = (x1, x2, y) =>
    `<line x1="${x1}" y1="${y}" x2="${x2 - 10}" y2="${y}" stroke="${C.faint}" stroke-width="2"/>` +
    `<polygon points="${x2 - 10},${y - 5} ${x2},${y} ${x2 - 10},${y + 5}" fill="${C.faint}"/>`

  const bw = 236
  b += box(64, bw, 'tools.schemas()', 'the full surface', C.blue)
  b += arrow(64 + bw, 64 + bw + 42, cy + 46)
  b += box(64 + bw + 42, 300, 'system-prompt/assemble', 'waterfall · per request', C.purple)
  b += arrow(64 + bw + 42 + 300, 64 + bw + 42 + 300 + 42, cy + 46)
  b += box(64 + bw + 42 + 300 + 42, bw + 16, 'the model', 'narrowed surface', C.green)

  b += t(64 + bw + 42 + 150, cy + 132, 'the guard rewrites here', { size: 12, fill: C.purple, anchor: 'middle' })
  b += t(64 + bw + 42 + 300 + 42 + (bw + 16) / 2, cy + 132, 'return value is authoritative', { size: 12, fill: C.green, anchor: 'middle' })

  // code
  const codeY = 380
  b += panel(64, codeY, W - 128, 264, 'apply(ctx)  ·  lib/index.js')
  const lines = [
    ["ctx.on('system-prompt/assemble',", "(assembly, context) => {", C.purple],
    ['  const mode = resolveMode(context)   // scope is the caller', '', C.dim],
    ['  return narrowTools(assembly.tools, mode)', '', C.text],
    ['})', '', C.purple],
    ['', '', C.text],
    ["ctx.on('tools/pre-execute',", "(exec, next) => {", C.purple],
    ['  // a cached schema can still send an unusable request', '', C.dim],
    ['  return isUnusableEscalation(...) ? deny(escalationCorrection(...)) : next()', '', C.text],
    ['})', '', C.purple],
  ]
  lines.forEach((l, i) => {
    const yy = codeY + 74 + i * 22
    b += t(90, yy, l[0], { size: 13.5, fill: l[2] })
    if (l[1]) b += t(90 + l[0].length * 8.15, yy, ' ' + l[1], { size: 13.5, fill: C.dim })
  })

  b += t(64, 678, '28 tests, including what the model is actually handed and that unmounting restores the original surface exactly.', { size: 13, fill: C.faint, font: SANS })

  return svg(H, b)
}

// ---------------------------------------------------------------- screenshot 4
function shotModes() {
  const H = 620
  let b = ''
  b += t(64, 72, 'Verified against the harness', { size: 30, weight: 700, font: SANS })
  b += t(64, 104, 'Output of node tools/… against a real Cordis context and a real systemPrompt registry.', { size: 15, fill: C.dim, font: SANS })

  const y = 156
  b += panel(64, y, W - 128, 344, 'Model-facing schema, per session mode', C.blue)

  const rows = [
    ['danger-full-access', ['properties = [command]', 'enum = ABSENT', 'escalation prose = STRIPPED'], C.green],
    ['workspace-write', ['properties = [command, sandbox_permissions, justification]', 'enum = ["danger-full-access"]', 'escalation prose = PRESENT'], C.amber],
    ['read-only', ['properties = [command, sandbox_permissions, justification]', 'enum = ["workspace-write", "danger-full-access"]', 'escalation prose = PRESENT'], C.green],
  ]
  rows.forEach((r, i) => {
    const yy = y + 74 + i * 86
    b += t(90, yy, r[0], { size: 14, fill: C.text })
    r[1].forEach((line, j) => {
      b += t(330, yy + j * 22, line, { size: 13, fill: r[2] })
    })
  })

  b += t(64, 552, 'The drift guard compares the mirrored ladder against @deepseek-ai/dsh-sandbox\u2019s own export whenever the', { size: 13, fill: C.faint, font: SANS })
  b += t(64, 574, 'harness is resolvable, and skips rather than fails when it is not.', { size: 13, fill: C.faint, font: SANS })

  return svg(H, b)
}

// ---------------------------------------------------------------- write + raster
mkdirSync(OUT, { recursive: true })

const shots = [
  ['01-before-after.png', shotComparison()],
  ['02-suppression-matrix.png', shotMatrix()],
  ['03-where-it-sits.png', shotWiring()],
  ['04-verified.png', shotModes()],
]

for (const [file, markup] of shots) {
  const svgPath = join(OUT, file.replace(/\.png$/, '.svg'))
  const pngPath = join(OUT, file)
  writeFileSync(svgPath, markup)
  execFileSync('rsvg-convert', ['-z', '2', '-o', pngPath, svgPath], { stdio: 'inherit' })
  console.log('wrote', file)
}
