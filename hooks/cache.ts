import type { CacheState, Ttl } from '../types'

// Pure cache-warmth estimate. The engine gives a mod no live warm/cold flag,
// so this tracks the last main-conversation cache hit and an inferred TTL.

export const MINUTE = 60_000
export const TTL_MS: Record<Ttl, number> = { '5m': 5 * MINUTE, '1h': 60 * MINUTE }

export type Step = { read: number; written: number; model: string; at: number }

export type Status = 'none' | 'working' | 'warm' | 'cooling' | 'cold'

export function initial(model: string): CacheState {
  return {
    model,
    lastHitAt: null,
    ttl: '1h',
    ttlSource: 'plan default',
    lastRead: 0,
    lastWritten: 0,
    totalRead: 0,
    totalWritten: 0,
    coldStarts: 0,
    contextPercent: null,
    contextTokens: 0,
    contextWindow: 0,
    isWorking: false,
    isCompacted: false,
  }
}

export function applyStep(state: CacheState | null, step: Step): CacheState {
  const prev = state ?? initial(step.model)
  if (step.read === 0 && step.written === 0) {
    return prev
  }

  const gap = prev.lastHitAt === null ? null : step.at - prev.lastHitAt
  const isCold = step.read === 0
  let { ttl, ttlSource } = prev

  // A setting is the person's own choice; use evidence only when there is none.
  if (ttlSource !== 'setting' && gap !== null) {
    if (!isCold && gap > TTL_MS['5m']) {
      // A read after more than 5 idle minutes proves the 1h cache.
      ttl = '1h'
      ttlSource = 'seen in use'
    } else if (isCold && prev.model === step.model && !prev.isCompacted &&
      gap > TTL_MS['5m'] && gap < TTL_MS['1h']) {
      // A full rewrite after 5 to 60 idle minutes points to the 5m cache.
      ttl = '5m'
      ttlSource = 'seen in use'
    }
  }

  return {
    ...prev,
    model: step.model,
    lastHitAt: step.at,
    ttl,
    ttlSource,
    lastRead: step.read,
    lastWritten: step.written,
    totalRead: prev.totalRead + step.read,
    totalWritten: prev.totalWritten + step.written,
    coldStarts: prev.coldStarts + (isCold ? 1 : 0),
    isCompacted: false,
  }
}

// The engine's own numbers when a session is resumed: seconds since the last
// response, its context size, and whether the engine thinks the cache expired.
export type Resume = {
  at: number
  model: string
  secondsSince: number
  contextTokens?: number
  isLikelyExpired?: boolean
}

export function fromResume(state: CacheState | null, resume: Resume): CacheState {
  const prev = state ?? initial(resume.model)
  const gap = resume.secondsSince * 1_000
  let { ttl, ttlSource } = prev
  if (ttlSource !== 'setting' && resume.isLikelyExpired !== undefined) {
    // The engine compares the gap with the TTL it used, so its verdict tells
    // which TTL that was whenever the gap falls between 5 and 60 minutes.
    if (resume.isLikelyExpired && gap < TTL_MS['1h']) {
      ttl = '5m'
      ttlSource = 'engine on resume'
    } else if (!resume.isLikelyExpired && gap > TTL_MS['5m']) {
      ttl = '1h'
      ttlSource = 'engine on resume'
    }
  }

  return {
    ...prev,
    model: resume.model,
    lastHitAt: resume.at - gap,
    ttl,
    ttlSource,
    lastRead: resume.contextTokens ?? prev.lastRead + prev.lastWritten,
    lastWritten: 0,
    contextTokens: resume.contextTokens ?? prev.contextTokens,
    isWorking: false,
    isCompacted: false,
  }
}

export function expiresAt(state: CacheState): number | null {
  return state.lastHitAt === null ? null : state.lastHitAt + TTL_MS[state.ttl]
}

// After a compact the cache holds nothing the next request can use, and the
// conversation is the summary: its size is what the next reply writes.
export function compacted(state: CacheState | null, at: number, tokensAfter?: number): CacheState | null {
  if (state === null) return null
  return {
    ...state,
    lastHitAt: state.lastHitAt === null ? null : at,
    contextTokens: tokensAfter && tokensAfter > 0 ? tokensAfter : state.contextTokens,
    contextPercent:
      tokensAfter && tokensAfter > 0 && state.contextWindow > 0 ? tokensAfter / state.contextWindow : state.contextPercent,
    isCompacted: true,
  }
}

export function status(state: CacheState | null, now: number): Status {
  if (state === null) return 'none'
  if (state.isWorking) return 'working'
  // The summary is a new prefix: nothing cached matches it.
  if (state.isCompacted) return 'cold'
  const end = expiresAt(state)
  if (end === null) return 'none'
  if (now >= end) return 'cold'
  // Warn in the last 5 minutes of a 1h cache, the last minute of a 5m one.
  const warnAt = state.ttl === '1h' ? 5 * MINUTE : MINUTE
  return end - now <= warnAt ? 'cooling' : 'warm'
}

// Tokens the next request reuses when warm, or rewrites when cold: the
// engine's context count when it has one, else the last request's cache use.
export function cachedTokens(state: CacheState): number {
  return state.contextTokens > 0 ? state.contextTokens : state.lastRead + state.lastWritten
}

export function hitRate(state: CacheState): number | null {
  const total = state.totalRead + state.totalWritten
  return total === 0 ? null : state.totalRead / total
}
