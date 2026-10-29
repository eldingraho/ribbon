import { MINUTE } from './cache'

export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`

  return String(n)
}

const CLOCK = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

export function clock(ms: number): string {
  return CLOCK.format(new Date(ms))
}

export function minutesLeft(ms: number): string {
  if (ms < MINUTE) return `${Math.max(0, Math.ceil(ms / 1_000))}s`

  return `${Math.ceil(ms / MINUTE)}m`
}

export function ago(ms: number): string {
  if (ms < MINUTE) return `${Math.max(0, Math.round(ms / 1_000))}s ago`
  if (ms < 60 * MINUTE) return `${Math.round(ms / MINUTE)}m ago`

  return `${Math.round(ms / (60 * MINUTE))}h ago`
}

export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`
}
