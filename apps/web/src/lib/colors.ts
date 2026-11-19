/** Stable cursor colour per user id (same user = same colour in every browser). */

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * Presence colours: deep enough for white initials (>= 4.5:1) and distinct from the brand teal and the
 * red/amber of errors and warnings.
 */
export const PRESENCE_COLORS = [
  '#2f6fb0', '#4d7c0f', '#6d3fd1', '#a3460e', '#9d174d', '#4338ca', '#7a5a12', '#155e75', '#57534e', '#86198f',
] as const

export function userColor(userId: string): { color: string; colorLight: string } {
  const color = PRESENCE_COLORS[hash(userId) % PRESENCE_COLORS.length] ?? PRESENCE_COLORS[0]
  return { color, colorLight: `${color}33` }
}

/** Up to two initials for a square avatar: "Bob Okafor" -> "BO", "carol" -> "CA". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = [...(words[0] ?? '')]
  if (words.length === 1) return first.slice(0, 2).join('').toUpperCase()
  const last = [...(words.at(-1) ?? '')]
  return `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase()
}
