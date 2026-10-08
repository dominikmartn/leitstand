// quiet: thin lines. Block glyphs fill the whole cell and merge across stacked rows.
export function meter(pct: number, width: number): [string, string] {
  const n = fill(pct, width)
  return ['━'.repeat(n), '─'.repeat(width - n)]
}

// loud: shade blocks like the original look. They fill the whole cell, so on a tight line height stacked bars touch.
export const DOT = '·'
const FULL = '▓'
const RAMP = ['░', '░', '▒', '▓']

// Solid body that dissolves at its edge, then dotted track
export function loudMeter(pct: number, width: number): [string, string] {
  const n = fill(pct, width)
  // A full bar is finished: no fading edge
  const fade = n === width ? [] : [...RAMP].reverse().slice(0, Math.min(2, n))
  return [FULL.repeat(n - fade.length) + fade.join(''), DOT.repeat(width - n)]
}

const fill = (pct: number, width: number) => Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
