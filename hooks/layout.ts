// Which band layout fits a width. Pure.
//
// Ribbon picks its layout from fixed column counts, but the desktop draws the
// band's text in a proportional font, where a dot is wider than a letter, so a
// layout could pass the count and still run past the edge. This estimates each
// layout's width from what it will say and takes the first one that fits.

// From roomiest to smallest:
// wide     everything on one row
// stacked  each window a block, the cache a third block
// split    the blocks, with the cache on a row below them
// mini     no USAGE label, shorter dot bars, the reset time without the word
//          "resets"
// list     one window per line without its reset time, for the narrowest column
// In split, mini and list the Show and Details buttons sit at the end of the
// cache row when they fit there, else on a line of their own. In mini and list
// that also splits the cache into short lines: Robo, the chip and the time;
// the price; the buttons.
export type Layout = 'wide' | 'stacked' | 'split' | 'mini' | 'list'
export type Pick = { layout: Layout; isButtonsBelow: boolean }

// Widths in band cells, measured from desktop screenshots: a letter is about a
// cell (capitals a little more), a dot a little over one, Robo and the chip
// about 10 cells.
const LETTER = 0.95
const DOT = 1.35
const MARGIN = 3
const LABEL = 5 * LETTER + 3
const BADGE = 10
// Show / Hide and Details, side by side.
const BUTTON = 17
// The band's padding, one cell each side, and room kept free so a near miss
// still fits. Checked against the desktop: at 49 columns the label and two
// ten-dot blocks need about 48.
const PAD = 2
const SLACK = 2

export type WindowText = { name: string; cells: number; left: string; isLow: boolean; reset: string }
/**
 * The cache's text at its longest for the current state: the one-line summary,
 * the time alone and the price alone (a stacked block puts them on two lines).
 */
export type CacheText = { summary: string; time: string; next: string | null } | null

const text = (s: string): number => s.length * LETTER

const wideWindow = (w: WindowText, cells: number): number =>
  text(`${w.name} `) + cells * DOT + text(` ${w.left} left`) + (w.isLow ? text(' LOW') : 0) +
  (w.reset ? text(` · ${w.reset}`) : 0) + MARGIN

const stackedWindow = (w: WindowText, cells: number): number =>
  Math.max(text(`${w.name} `) + cells * DOT, text(`${w.left} left${w.isLow ? ' LOW' : ''}`), w.reset ? text(`resets ${w.reset}`) : 0) +
  MARGIN

// A block with the word "resets" left out, under no label.
const miniWindow = (w: WindowText, cells: number): number =>
  Math.max(text(`${w.name} `) + cells * DOT, text(`${w.left} left${w.isLow ? ' LOW' : ''}`), text(w.reset)) + MARGIN

// Blocks sit side by side with a margin between them, none after the last.
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) - (xs.length > 0 ? MARGIN : 0)
const most = (xs: number[]): number => xs.reduce((a, b) => Math.max(a, b), 0)

/** How wide each layout is, in cells, with the buttons beside the cache and below it. */
export function widths(windows: readonly WindowText[], cache: CacheText, cells: number, tightCells: number) {
  const button = cache ? BUTTON : 0
  const wideCache = cache ? BADGE + text(cache.summary) + 2 : 0
  const blockCache = cache ? Math.max(BADGE, text(cache.time), cache.next ? text(`${cache.next} next`) : 0) + 2 : 0
  const cacheInline = cache ? BADGE + text(cache.summary) + button : 0
  const cacheBelow = cache ? Math.max(BADGE + text(cache.summary), button) : 0
  const cacheLines = cache ? Math.max(BADGE + text(cache.time), cache.next ? text(`${cache.next} next`) : 0, button) : 0
  const blocks = sum(windows.map(w => stackedWindow(w, cells)))
  const minis = sum(windows.map(w => miniWindow(w, tightCells)))
  const lines = most(windows.map(w => wideWindow({ ...w, reset: '' }, tightCells) - MARGIN))

  return {
    wide: PAD + LABEL + sum(windows.map(w => wideWindow(w, cells))) + (cache ? MARGIN + wideCache + button : 0),
    stacked: PAD + LABEL + blocks + (cache ? MARGIN + blockCache + button : 0),
    // The cache row sits under the blocks, right of the label.
    split: PAD + LABEL + Math.max(blocks, cacheInline),
    splitBelow: PAD + LABEL + Math.max(blocks, cacheBelow),
    mini: PAD + Math.max(minis, cacheInline),
    miniBelow: PAD + Math.max(minis, cacheLines),
    list: PAD + Math.max(lines, cacheInline),
    listBelow: PAD + Math.max(lines, cacheLines),
  }
}

/** The roomiest layout that fits `columns`; when none does, the one that needs least. */
export function pickLayout(
  columns: number,
  windows: readonly WindowText[],
  cache: CacheText,
  cells: number,
  tightCells: number,
): Pick {
  const need = widths(windows, cache, cells, tightCells)
  const room = columns - SLACK
  const order: { key: keyof typeof need; pick: Pick }[] = [
    { key: 'wide', pick: { layout: 'wide', isButtonsBelow: false } },
    { key: 'stacked', pick: { layout: 'stacked', isButtonsBelow: false } },
    { key: 'split', pick: { layout: 'split', isButtonsBelow: false } },
    { key: 'splitBelow', pick: { layout: 'split', isButtonsBelow: true } },
    { key: 'mini', pick: { layout: 'mini', isButtonsBelow: false } },
    { key: 'miniBelow', pick: { layout: 'mini', isButtonsBelow: true } },
    { key: 'list', pick: { layout: 'list', isButtonsBelow: false } },
    { key: 'listBelow', pick: { layout: 'list', isButtonsBelow: true } },
  ]
  for (const one of order) {
    if (need[one.key] <= room) return one.pick
  }

  return order.reduce((best, one) => (need[one.key] < need[best.key] ? one : best)).pick
}
