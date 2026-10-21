// Clawd, the Claude Code crab, as frame-by-frame pixel sprites, one loop per activity.
//   Proportions are the official mascot's (Codrops' rect-by-rect rebuild, 2026-05-05):
//   on a 2-pixel unit, a 16x12 body, 4x4 hands, 2x2 eyes and four 2x4 legs. Like the
//   official clips, each activity has its own prop and pose: a book, a magnifier, a
//   pencil and paper, a headband for a run, a spinning globe, thought dots, confetti, a
//   rain cloud. Each SVG holds every frame of its loop and shows one at a time with
//   discrete SMIL, which the Desktop app runs in an interactive (sandboxed) Svg.
import type { Activity } from '../types'

export const W = 38
export const H = 22
const OX = 4 // Clawd's left edge on the canvas
const OY = 6 // Clawd's top edge; the ground is at H

const PALETTE: Record<string, string> = {
  O: '#DD775B', // body
  g: '#8A8A8A', // body, failed
  K: '#000000', // eyes
  W: '#F3EEE6', // paper
  G: '#A39C94', // ink lines
  B: '#3F6FC4', // book cover
  Y: '#F2C14E', // pencil
  P: '#E88FA3', // eraser
  D: '#3A3A3A', // pencil tip, magnifier handle
  M: '#D3D9DF', // magnifier ring
  H: '#9A6A3C', // magnifier handle
  L: '#8FCBEA', // lens
  N: '#2F4C86', // headband
  F: '#8A8F96', // speed lines, dust
  U: '#4A90D9', // globe sea
  E: '#5DBB63', // globe land
  C: '#B7BDC4', // cloud
  R: '#6FB3E8', // rain
  T: '#BDBDBD', // thought dots
  S: '#7FC8F0', // sweat
  '1': '#E07A5F',
  '2': '#F2C14E',
  '3': '#6FA8DC',
  '4': '#C77DFF',
  '5': '#7BD389',
}

type Eyes = 'open' | 'closed' | 'happy' | 'x' | 'squint'

// One frame: Clawd's pose plus props, held for `hold` seconds.
type Frame = {
  hold: number
  dx?: number
  dy?: number
  eyes?: Eyes
  look?: [number, number]
  armL?: number
  armR?: number
  lift?: [number, number, number, number]
  air?: boolean
  headband?: boolean
  body?: string
  props?: Sprite[]
}

type Sprite = { x: number; y: number; rows: string[] }

// A pixel canvas: later paints cover earlier ones.
class Canvas {
  px = new Map<string, string>()
  set(x: number, y: number, c: string) {
    if (x >= 0 && y >= 0 && x < W && y < H) this.px.set(`${x},${y}`, c)
  }
  rect(x: number, y: number, w: number, h: number, c: string) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c)
  }
  sprite(s: Sprite) {
    s.rows.forEach((row, j) => [...row].forEach((ch, i) => ch !== '.' && this.set(s.x + i, s.y + j, ch)))
  }
  // One path per color: runs of a color on a row, merged down the rows while they
  // line up, become rectangles. Keeps a frame to a few hundred characters.
  toPaths(): string {
    const runs = new Map<string, { x: number; y: number; n: number; h: number }[]>()
    const open = new Map<string, { x: number; y: number; n: number; h: number }>()
    for (let y = 0; y < H; y++) {
      let x = 0
      while (x < W) {
        const c = this.px.get(`${x},${y}`)
        if (!c) {
          x++
          continue
        }
        let n = 1
        while (this.px.get(`${x + n},${y}`) === c) n++
        const key = `${c}|${x}|${n}`
        const above = open.get(key)
        if (above && above.y + above.h === y) above.h++
        else {
          const r = { x, y, n, h: 1 }
          open.set(key, r)
          runs.set(c, [...(runs.get(c) ?? []), r])
        }
        x += n
      }
    }
    let out = ''
    for (const [c, rs] of runs) out += `<path fill="${PALETTE[c] ?? c}" d="${rs.map(r => `M${r.x} ${r.y}h${r.n}v${r.h}h-${r.n}z`).join('')}"/>`
    return out
  }
}

const EYES: Record<Eyes, string[]> = {
  open: ['KK', 'KK'],
  closed: ['..', 'KK'],
  squint: ['K.', '.K'],
  happy: ['.K.', 'K.K'],
  x: ['K.K', '.K.', 'K.K'],
}

function drawFrame(f: Frame): string {
  const c = new Canvas()
  const ox = OX + (f.dx ?? 0)
  const oy = OY + (f.dy ?? 0)
  const body = f.body ?? 'O'
  const lift = f.lift ?? [0, 0, 0, 0]
  ;[4, 8, 14, 18].forEach((lx, i) => {
    const top = oy + 12
    const h = (f.air ? 4 : H - top) - lift[i]!
    if (h > 0) c.rect(ox + lx, top, 2, h, body)
  })
  c.rect(ox + 4, oy, 16, 12, body)
  c.rect(ox, oy + 4 + (f.armL ?? 0), 4, 4, body)
  c.rect(ox + 20, oy + 4 + (f.armR ?? 0), 4, 4, body)
  if (f.headband) {
    c.rect(ox + 4, oy + 1, 16, 1, 'N')
    // The knot's tails stream back behind a runner.
    c.set(ox + 3, oy + 1, 'N')
    c.rect(ox + 1, oy + 2 + ((f.dy ?? 0) < 0 ? -1 : 0), 2, 1, 'N')
  }
  const eyes = EYES[f.eyes ?? 'open']
  const [lx, ly] = f.look ?? [0, 0]
  const shift = eyes[0]!.length === 3 ? -1 : 0
  for (const ex of [6, 16]) c.sprite({ x: ox + ex + lx + (eyes[0]!.length === 3 && ex === 6 ? 0 : shift), y: oy + 2 + ly + (eyes.length === 3 ? -1 : 0), rows: eyes })
  for (const p of f.props ?? []) c.sprite(p)
  return c.toPaths()
}

// ---------------------------------------------------------------- props

const dots = (n: number): Sprite[] =>
  [
    { x: 29, y: 5, rows: ['T'] },
    { x: 31, y: 2, rows: ['TT', 'TT'] },
    { x: 34, y: 0, rows: ['TTT', 'TTT'] },
  ].slice(0, n)

// An open book like the emoji: blue cover at the sides and bottom, pages dipping to the
// spine, lines of text that change with the page.
function book(page: number, flip: 0 | 1 | 2): Sprite[] {
  const text = page % 2 ? ['BGGGGWWWW', 'WGGGGGWWW', 'WGGGWWWWW'] : ['BGGGGGWWW', 'WGGGWWWWW', 'WGGGGGWWW']
  const left = [
    '..WWWW...',
    'WWWWWWWW.',
    text[0]!,
    'BWWWWWWWW',
    text[1]!.replace(/^W/, 'B'),
    'BWWWWWWWW',
    text[2]!.replace(/^W/, 'B'),
    'BBBBWWWWW',
    '....BBBBB',
  ]
  const spine = ['.', '.', 'G', 'G', 'G', 'G', 'G', 'W', 'B']
  const rows = left.map((r, j) => r + spine[j] + [...left[j]!].reverse().join(''))
  const out: Sprite[] = [{ x: OX + 3, y: OY + 5, rows }]
  // A page lifting off the right half and laying over the left.
  if (flip === 1) out.push({ x: OX + 13, y: OY + 1, rows: ['WW', 'WW', 'WW', 'WW'] })
  if (flip === 2) out.push({ x: OX + 6, y: OY + 2, rows: ['.WWWWW', 'WWWWWW', '..WWWW'] })
  return out
}

// A magnifying glass like the emoji, held up in front: a silver ring, a blue lens with
// a shine, and a wooden handle running down into Clawd's raised hand.
const GLASS = [
  '.....MMMMM..',
  '....MLLLLLM.',
  '...MLWWLLLLM',
  '...MLWLLLLLM',
  '...MLLLLLLLM',
  '...MLLLLLLLM',
  '...MLLLLLLLM',
  '....MLLLLLM.',
  '...HHMMMMM..',
  '..HHH.......',
  '.HHH........',
  'HH..........',
]

function glass(dx: number, dy: number, glint: boolean): Sprite[] {
  const lens: Sprite = { x: OX + dx + 19, y: OY - 6 + dy, rows: GLASS }
  // The sparkle sits off the lens's upper left, where the canvas has room for it.
  return glint ? [lens, { x: OX + dx + 19, y: OY - 6 + dy, rows: ['.W.', 'WWW', '.W.'] }] : [lens]
}

function pencilAndPaper(len: number[]): Sprite[] {
  const paper = Array.from({ length: 9 }, () => 'WWWWWWW')
  len.forEach((n, k) => {
    const r = 2 + k * 2
    paper[r] = 'W' + 'G'.repeat(n) + 'W'.repeat(6 - n)
  })
  const k = len.length ? len.length - 1 : 0
  const tx = 30 + (len[k] ?? 0)
  const ty = 15 + k * 2
  const pencil: Sprite[] = [
    { x: tx, y: ty, rows: ['D'] },
    { x: tx - 1, y: ty - 1, rows: ['Y'] },
    { x: tx - 2, y: ty - 2, rows: ['Y'] },
    { x: tx - 3, y: ty - 3, rows: ['Y'] },
    { x: tx - 4, y: ty - 4, rows: ['P'] },
  ]
  return [{ x: 29, y: 13, rows: paper }, ...pencil]
}

// Speed lines streaming back past a running Clawd (who runs in place, 5 right of usual).
function speedLines(k: number): Sprite[] {
  return [
    [OY + 3, 4, 0],
    [OY + 9, 4, 5],
  ].map(([y, n, phase]) => ({ x: ((phase! - 2 * k) % 9 + 9) % 9 - 2, y: y!, rows: ['F'.repeat(n!)] }))
}

const LAND = ['......EE......', '..EE..EEE...E.', '.EEEE..EE..EEE', '..EEE...E..EE.', '...E.......E..', '..........EE..', '..............']
const DISC = ['..UUU..', '.UUUUU.', 'UUUUUUU', 'UUUUUUU', 'UUUUUUU', '.UUUUU.', '..UUU..']

function globe(turn: number, dy: number): Sprite {
  const rows = DISC.map((r, j) =>
    [...r].map((ch, i) => (ch === 'U' && LAND[j]![(i + turn) % 14] === 'E' ? 'E' : ch)).join(''),
  )
  return { x: 30, y: 0 + dy, rows }
}

// Confetti bursting from above Clawd, frame by frame.
function confetti(t: number, fromX: number): Sprite[] {
  const bits = [
    [-6, -5, '1'], [-3, -7, '2'], [0, -8, '3'], [3, -7, '4'], [6, -5, '5'], [-5, -3, '3'], [5, -3, '1'], [1, -6, '5'],
  ] as const
  if (t === 0) return []
  return bits.map(([vx, vy, col]) => {
    const x = Math.round(fromX + (vx * t) / 3)
    const y = Math.round(6 + (vy * t) / 2 + (t * t) / 2.2)
    return { x, y, rows: [col] }
  })
}

const cloud = (shift: number): Sprite[] => [
  { x: OX + 6, y: 0, rows: ['..CCCC..', '.CCCCCCC', 'CCCCCCCC'] },
  { x: OX + 7, y: 3 + shift, rows: ['R...R...'] },
  { x: OX + 9, y: 4 - shift, rows: ['R...R'] },
]

// ---------------------------------------------------------------- loops

const A: [number, number, number, number] = [1, 0, 1, 0]
const B: [number, number, number, number] = [0, 1, 0, 1]

export const LOOPS: Record<Activity, Frame[]> = {
  think: [
    { hold: 0.42, look: [1, -1], props: dots(1) },
    { hold: 0.42, look: [1, -1], props: dots(2) },
    { hold: 0.68, look: [1, -1], props: dots(3) },
    { hold: 0.1, look: [1, -1], eyes: 'closed', props: dots(3) },
    { hold: 0.5, look: [0, 0] },
  ],
  read: [
    { hold: 0.55, look: [-1, 1], armL: 3, armR: 3, props: book(0, 0) },
    { hold: 0.55, look: [1, 1], armL: 3, armR: 3, props: book(0, 0) },
    { hold: 0.12, look: [1, 1], armL: 3, armR: 1, props: book(0, 1) },
    { hold: 0.12, look: [0, 1], armL: 3, armR: 2, props: book(1, 2) },
    { hold: 0.55, look: [-1, 1], armL: 3, armR: 3, props: book(1, 0) },
    { hold: 0.12, look: [-1, 1], eyes: 'closed', armL: 3, armR: 3, props: book(1, 0) },
    { hold: 0.55, look: [1, 1], armL: 3, armR: 3, props: book(1, 0) },
  ],
  // Peering through the glass, it steps forward, pauses (the lens glints), backs up.
  search: [
    { hold: 0.2, dx: 0, lift: A, look: [1, -1], armR: -2, props: glass(0, 0, false) },
    { hold: 0.2, dx: 1, lift: B, look: [1, -1], armR: -1, props: glass(1, 1, false) },
    { hold: 0.2, dx: 2, lift: A, look: [1, -1], armR: -2, props: glass(2, 0, false) },
    { hold: 0.5, dx: 2, look: [1, -1], armR: -2, props: glass(2, 0, true) },
    { hold: 0.2, dx: 2, look: [1, 0], armR: -1, props: glass(2, 1, false) },
    { hold: 0.2, dx: 1, lift: B, look: [1, 0], armR: -2, props: glass(1, 0, false) },
    { hold: 0.2, dx: 0, lift: A, look: [1, -1], armR: -1, props: glass(0, 1, false) },
    { hold: 0.2, dx: -1, lift: B, look: [1, -1], armR: -2, props: glass(-1, 0, false) },
    { hold: 0.5, dx: -1, look: [1, -1], armR: -2, props: glass(-1, 0, true) },
  ],
  edit: [
    { hold: 0.16, look: [1, 1], armR: 1, props: pencilAndPaper([1]) },
    { hold: 0.16, look: [1, 1], armR: 0, props: pencilAndPaper([3]) },
    { hold: 0.16, look: [1, 1], armR: 1, props: pencilAndPaper([5]) },
    { hold: 0.16, look: [1, 1], armR: 2, props: pencilAndPaper([5, 2]) },
    { hold: 0.16, look: [1, 1], armR: 3, props: pencilAndPaper([5, 5]) },
    { hold: 0.16, look: [1, 1], armR: 4, props: pencilAndPaper([5, 5, 3]) },
    { hold: 0.5, look: [1, 1], eyes: 'happy', armR: 4, props: pencilAndPaper([5, 5, 5]) },
    { hold: 0.25, look: [0, 0], armR: 0, props: pencilAndPaper([]) },
  ],
  // A steady run in place: legs step in pairs, a small bob between strides, arms swing
  // against the legs, and two speed lines drift back.
  run: [0, 1, 2, 3, 4, 5, 6, 7].map((k): Frame => {
    const stride = k % 4 // 0 and 2: one pair of legs is up; 1 and 3: passing
    return {
      hold: 0.14,
      dx: 5,
      dy: stride % 2 ? -1 : 0,
      headband: true,
      look: [1, 0],
      lift: stride === 0 ? [2, 0, 2, 0] : stride === 2 ? [0, 2, 0, 2] : [0, 0, 0, 0],
      armL: stride === 0 ? -1 : stride === 2 ? 1 : 0,
      armR: stride === 0 ? 1 : stride === 2 ? -1 : 0,
      props: speedLines(k),
    }
  }),
  web: [0, 1, 2, 3, 4, 5, 6].map((k): Frame => ({
    hold: 0.2,
    look: [1, -1],
    lift: k % 2 ? [0, 0, 0, 1] : [0, 0, 0, 0],
    armR: k % 4 < 2 ? -2 : -3,
    props: [globe(k * 2, k % 4 < 2 ? 0 : 1)],
  })),
  done: [0, 1, 2, 3, 4, 5, 6, 7].map((t): Frame => {
    const side = t % 4
    return {
      hold: 0.145,
      eyes: 'happy',
      dx: side === 1 ? -1 : side === 3 ? 1 : 0,
      armL: side === 1 ? -5 : 0,
      armR: side === 3 ? -5 : 0,
      lift: side === 1 ? [0, 0, 1, 1] : side === 3 ? [1, 1, 0, 0] : [0, 0, 0, 0],
      props: confetti(t, t < 4 ? 9 : 27),
    }
  }),
  failed: [
    { hold: 0.3, dy: 1, body: 'g', eyes: 'x', props: cloud(0) },
    { hold: 0.3, dy: 1, body: 'g', eyes: 'x', props: cloud(1) },
  ],
}

// Every frame in one SVG, each visible for its slot of the loop.
export function crabSvg(activity: Activity): string {
  const frames = LOOPS[activity]
  const total = frames.reduce((s, f) => s + f.hold, 0)
  let t = 0
  const groups = frames.map((f, i) => {
    const a = t / total
    t += f.hold
    const b = t / total
    if (frames.length === 1) return `<g>${drawFrame(f)}</g>`
    const r = (n: number) => Number(n.toFixed(4))
    const anim =
      i === 0
        ? `values="visible;hidden" keyTimes="0;${r(b)}"`
        : i === frames.length - 1
          ? `values="hidden;visible" keyTimes="0;${r(a)}"`
          : `values="hidden;visible;hidden" keyTimes="0;${r(a)};${r(b)}"`
    return `<g visibility="hidden">${drawFrame(f)}<animate attributeName="visibility" ${anim} calcMode="discrete" dur="${r(total)}s" repeatCount="indefinite"/></g>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">${groups.join('')}</svg>`
}

// The terminal has no Svg: a small glyph crab instead, its legs stepping by frame.
export function crabGlyph(activity: Activity, frame: number): string {
  if (activity === 'failed') return '▐▀█▀▌'
  if (activity === 'done') return frame % 2 ? '▐▛█▜▌' : '▝▜█▛▘'
  return frame % 2 ? '▐▛█▜▌' : '▗▛█▜▖'
}
