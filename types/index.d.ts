export type Ttl = '5m' | '1h'

export type CacheState = {
  model: string
  // When the main conversation last read or wrote the cache; null when unknown.
  lastHitAt: number | null
  ttl: Ttl
  ttlSource: 'plan default' | 'setting' | 'seen in use' | 'over plan limits' | 'engine on resume'
  lastRead: number
  lastWritten: number
  totalRead: number
  totalWritten: number
  coldStarts: number
  contextPercent: number | null
  // Context the next request re-sends, and the model's window, from the engine.
  contextTokens: number
  contextWindow: number
  isWorking: boolean
  isCompacted: boolean
}

export type SkillRun = {
  name: string
  by: 'you' | 'claude'
  at: number
  count: number
}

// What is kept in $.store per session, so a reopened session picks up
// where it was after an app restart.
export type Saved = { cache: CacheState | null; skills: SkillRun[]; savedAt: number }

/** One usage window: which one, how much is used (0 to 100), when it resets. */
export type Window = { kind: string; percentUsed: number; resetsAt?: string }

/** Whether the cache card is open, remembered only for the state it was set in. */
export type Fold = { mode: 'warm' | 'cold'; open: boolean }

declare module 'claude-code' {
  interface PluginState {
    'cache-glance': {
      cache: Shaped<CacheState | null>
      skills: Shaped<SkillRun[]>
      windows: Window[]
      fold: Fold | null
      isExpanded: boolean
    }
  }
}
