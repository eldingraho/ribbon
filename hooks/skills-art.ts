// The skills strip under the cache card, drawn in the card's own style (from
// Ribbon's cache-art): a spaced label, rounded chips, the embedded font. Pure.

import type { SkillRun } from '../types'
import { BG, LINE, MUTED, TEXT, chipShapes, svgDoc } from './cache-art'

// Who started a skill. Kept apart from the band's orange, yellow, red and blue.
export const BY_HUE: Record<SkillRun['by'], string> = { you: '#a89bdc', claude: '#d4a27f' }
export const BY_WORD: Record<SkillRun['by'], string> = { you: 'YOU', claude: 'CLAUDE' }

const HEAD = 34
const ROW = 26
const FOOT = 10
// One chip width for YOU and CLAUDE, so every name starts at the same x.
const CHIP_W = 60
const NAME_X = 13 + CHIP_W + 10
// Room the right-hand count and clock take, and a 14 px semibold character.
const RIGHT = 100
const CHAR_PX = 8.4

/** A name cut to fit before the count and clock, ending in an ellipsis. */
export const fitName = (name: string, W: number): string => {
  const room = Math.max(6, Math.floor((W - NAME_X - RIGHT) / CHAR_PX))
  return name.length <= room ? name : `${name.slice(0, room - 1)}…`
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const skillsSvg = (
  runs: readonly SkillRun[],
  total: number,
  W: number,
  clock: (ms: number) => string,
): { source: string; w: number; h: number; alt: string } => {
  const t = (x: number, y: number, str: string, size: number, w: number, fill: string, ls = 0, anchor = 'start') =>
    `<text x="${x}" y="${y}" font-size="${size}" font-weight="${w}" fill="${fill}" letter-spacing="${ls}" text-anchor="${anchor}">${esc(str)}</text>`

  let g = `<rect x="13" y="0" width="${W - 26}" height="1" fill="${LINE}"/>`
  g += t(13, 24, 'SKILLS', 11, 700, MUTED, 1.4)
  g += t(W - 13, 24, total === 1 ? '1 RUN' : `${total} RUNS`, 11, 700, MUTED, 1.4, 'end')
  if (runs.length === 0) {
    g += t(13, HEAD + 18, 'Skills you or Claude run show up here.', 12, 500, MUTED)
  }
  runs.forEach((run, i) => {
    const y = HEAD + i * ROW
    const chip = chipShapes(13, y + 4, BY_WORD[run.by], BY_HUE[run.by], 10, 0.8, CHIP_W)
    const name = fitName(run.by === 'you' ? `/${run.name}` : run.name, W)
    g += chip.svg
    g += t(NAME_X, y + 17, name, 14, 600, TEXT)
    if (run.count > 1) g += t(W - 70, y + 17, `×${run.count}`, 12, 600, MUTED, 0, 'end')
    g += t(W - 13, y + 17, clock(run.at), 12, 500, MUTED, 0, 'end')
  })
  const rows = Math.max(1, runs.length)
  const h = HEAD + rows * ROW + FOOT
  const body = `<rect width="${W}" height="${h}" fill="${BG}"/>` + g
  const alt =
    runs.length === 0
      ? 'No skills run yet.'
      : `Skills: ${runs.map(r => `${r.by === 'you' ? '/' : ''}${r.name} by ${r.by === 'you' ? 'you' : 'Claude'}`).join(', ')}.`

  return { source: svgDoc(W, h, body, true), w: W, h, alt }
}
