import type { SkillRun } from '../types'

const MAX_RUNS = 200
// A typed command can arrive both as a prompt and as a command event.
const SAME_COMMAND_MS = 3_000

export function addRun(
  list: readonly SkillRun[],
  name: string,
  by: SkillRun['by'],
  at: number,
): SkillRun[] {
  const last = list[list.length - 1]
  if (last && last.name === name && last.by === by) {
    if (by === 'you' && at - last.at < SAME_COMMAND_MS) {
      return [...list]
    }

    return [...list.slice(0, -1), { ...last, at, count: last.count + 1 }]
  }

  return [...list, { name, by, at, count: 1 }].slice(-MAX_RUNS)
}

export function totalRuns(list: readonly SkillRun[]): number {
  return list.reduce((sum, run) => sum + run.count, 0)
}

// "/egm:egm_brainstorm args" -> "egm:egm_brainstorm"
export function commandName(text: string): string | null {
  const match = /^\/([\w:.-]+)/.exec(text.trim())

  return match?.[1] ?? null
}
