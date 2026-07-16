// Today's leaderboard state: counts per repo, UTC-day reset, 30-day history
// snapshots for FRESH / STREAK / RETURNING tiers. Persisted in localStorage.

const DAY_KEY = 'starfall.day'
const HISTORY_KEY = 'starfall.history' // { "YYYY-MM-DD": ["owner/repo", ... top100] }

export const state = {
  date: utcDate(),
  counts: new Map(), // full -> today's observed stars
  meta: new Map(), // full -> {desc, lang, langColor, stars, topics, fetchedAt}
  seenEvents: new Set(),
  totalStarsToday: 0,
  history: JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}'),
}

export function utcDate(d = new Date()) {
  return d.toISOString().slice(0, 10)
}

export function loadDay() {
  try {
    const saved = JSON.parse(localStorage.getItem(DAY_KEY) || 'null')
    if (saved && saved.date === state.date) {
      state.counts = new Map(saved.counts)
      state.totalStarsToday = saved.total
      state.seenEvents = new Set(saved.seen || [])
    }
  } catch {}
}

export function saveDay() {
  const seen = [...state.seenEvents]
  localStorage.setItem(
    DAY_KEY,
    JSON.stringify({
      date: state.date,
      counts: [...state.counts],
      total: state.totalStarsToday,
      seen: seen.slice(-3000),
    }),
  )
}

// Returns true if the UTC day rolled over (caller should re-render everything).
export function maybeRollover() {
  const today = utcDate()
  if (today === state.date) return false
  state.history[state.date] = top(100).map(([full]) => full)
  const days = Object.keys(state.history).sort()
  for (const d of days.slice(0, Math.max(0, days.length - 30))) delete state.history[d]
  localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history))
  state.date = today
  state.counts = new Map()
  state.seenEvents = new Set()
  state.totalStarsToday = 0
  saveDay()
  return true
}

export function ingest(events, persist = true) {
  const fresh = []
  for (const e of events) {
    if (state.seenEvents.has(e.id)) continue
    state.seenEvents.add(e.id)
    if (utcDate(new Date(e.created_at)) !== state.date) continue
    const full = e.repo.name
    state.counts.set(full, (state.counts.get(full) || 0) + 1)
    state.totalStarsToday++
    fresh.push(e)
  }
  if (fresh.length && persist) saveDay()
  return fresh
}

export function top(n) {
  return [...state.counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
}

// FRESH: never in top-100 in stored history. STREAK: present the last 2 days
// too. RETURNING: seen in the last 30 days but not on a streak.
export function tierOf(full) {
  const days = Object.keys(state.history).sort().reverse()
  if (days.length === 0) return 'fresh'
  const appears = days.filter((d) => state.history[d].includes(full))
  if (appears.length === 0) return 'fresh'
  const y1 = days[0], y2 = days[1]
  if (appears.includes(y1) && (days.length < 2 || appears.includes(y2))) return 'streak'
  return 'returning'
}

export function topicCounts() {
  const counts = new Map()
  for (const [full] of top(100)) {
    const m = state.meta.get(full)
    for (const t of m?.topics || []) counts.set(t, (counts.get(t) || 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)
}
