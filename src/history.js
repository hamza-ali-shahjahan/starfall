// Star-history crawler, two strategies:
//   - small repos (≤2000 stars, token present): exact curve from a GraphQL
//     backward walk over stargazer timestamps
//   - everything else: monthly WatchEvent counts from the public ClickHouse
//     GH Archive mirror (play.clickhouse.com, CORS-open, no auth), anchored
//     at today's live total. Approximate: unstars aren't subtracted, and a
//     renamed repo's early history may be missing (flagged as partial).
// Cached 24h in localStorage.
import { headers, getToken } from './api.js'

const API = 'https://api.github.com'
const CH = 'https://play.clickhouse.com/?user=play'
const CACHE_KEY = 'starfall.histcache'
const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}')

function saveCache() {
  const keys = Object.keys(cache)
  if (keys.length > 60) for (const k of keys.slice(0, keys.length - 60)) delete cache[k]
  localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
}

async function exactWalk(full, total) {
  const [o, n] = full.split('/')
  const stamps = []
  let cursor = null
  for (let p = 0; p < 20; p++) {
    const arg = cursor ? `last: 100, before: ${JSON.stringify(cursor)}` : 'last: 100'
    const q = `{ repository(owner: ${JSON.stringify(o)}, name: ${JSON.stringify(n)}) {
      stargazers(${arg}) { edges { starredAt } pageInfo { startCursor hasPreviousPage } } } }`
    const res = await fetch(`${API}/graphql`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ query: q }),
    })
    if (!res.ok) throw new Error(`graphql ${res.status}`)
    const sg = (await res.json()).data?.repository?.stargazers
    if (!sg) throw new Error('no stargazers')
    stamps.unshift(...sg.edges.map((e) => e.starredAt))
    if (!sg.pageInfo.hasPreviousPage) break
    cursor = sg.pageInfo.startCursor
  }
  const base = total - stamps.length
  const step = Math.max(1, Math.floor(stamps.length / 40))
  const points = []
  for (let i = 0; i < stamps.length; i += step) points.push({ t: stamps[i], count: base + i + 1 })
  points.push({ t: new Date().toISOString(), count: total })
  return { points, exact: true, partial: false }
}

async function archiveCurve(full, total) {
  if (!/^[A-Za-z0-9_.\/-]+$/.test(full)) throw new Error('bad repo name')
  const sql = `SELECT toStartOfMonth(created_at) AS m, count() AS c
    FROM github_events
    WHERE event_type = 'WatchEvent' AND repo_name = '${full}'
    GROUP BY m ORDER BY m FORMAT JSONCompact`
  const res = await fetch(CH, { method: 'POST', body: sql })
  if (!res.ok) throw new Error(`clickhouse ${res.status}`)
  const { data } = await res.json()
  if (!data?.length) throw new Error('no archive rows')
  let cum = 0
  const points = data.map(([m, c]) => {
    cum += Number(c)
    return { t: m + 'T00:00:00Z', count: cum }
  })
  points.push({ t: new Date().toISOString(), count: total })
  return { points, exact: false, partial: cum < total * 0.6 }
}

export async function fetchStarHistory(full, knownTotal) {
  const hit = cache[full]
  if (hit && Date.now() - hit.at < 24 * 3600_000) return hit
  let total = knownTotal
  let createdAt = null
  if (total == null) {
    const res = await fetch(`${API}/repos/${full}`, { headers: headers() })
    if (res.status === 403 || res.status === 429) throw Object.assign(new Error('rate-limited'), { rateLimited: true })
    if (!res.ok) throw new Error(`repo ${res.status}`)
    const j = await res.json()
    total = j.stargazers_count
    createdAt = j.created_at
  }
  let entry
  if (total <= 2000 && getToken()) {
    try {
      entry = await exactWalk(full, total)
    } catch {
      entry = await archiveCurve(full, total).catch(() => null)
    }
  } else {
    try {
      entry = await archiveCurve(full, total)
    } catch {
      entry = getToken() && total <= 5000 ? await exactWalk(full, total).catch(() => null) : null
    }
  }
  if (!entry) {
    // repo younger than the archive (or archive miss): birth → today straight line
    if (!createdAt) {
      const res = await fetch(`${API}/repos/${full}`, { headers: headers() })
      if (res.ok) createdAt = (await res.json()).created_at
    }
    if (!createdAt) throw new Error('no history sources')
    entry = {
      points: [
        { t: createdAt, count: 0 },
        { t: new Date().toISOString(), count: total },
      ],
      exact: false,
      partial: false,
      birthline: true,
    }
  }
  entry.at = Date.now()
  entry.total = total
  cache[full] = entry
  saveCache()
  return entry
}

// Render points into a small SVG line chart string.
export function historyChartSvg(entry, w = 300, h = 110) {
  const pts = entry.points
  if (pts.length < 2) return `<div class="muted">not enough history yet</div>`
  const t0 = new Date(pts[0].t).getTime()
  const t1 = new Date(pts[pts.length - 1].t).getTime()
  const span = Math.max(1, t1 - t0)
  const max = Math.max(...pts.map((p) => p.count), 1)
  const px = (p) => 4 + ((new Date(p.t).getTime() - t0) / span) * (w - 8)
  const py = (p) => h - 16 - (p.count / max) * (h - 26)
  const line = pts.map((p) => `${px(p).toFixed(1)},${py(p).toFixed(1)}`).join(' ')
  const d0 = new Date(t0).toISOString().slice(0, 10)
  const d1 = new Date(t1).toISOString().slice(0, 10)
  const note = entry.exact
    ? 'exact'
    : entry.birthline
      ? 'young repo · birth → today'
      : entry.partial
        ? 'history incomplete (archive gap)'
        : 'archive + live anchor'
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}">
    <polyline points="${line}" fill="none" stroke="#e8b33d" stroke-width="1.6"/>
    <text x="4" y="${h - 3}" fill="#5c6675" font-size="10" font-family="monospace">${d0}</text>
    <text x="${w - 4}" y="${h - 3}" fill="#5c6675" font-size="10" font-family="monospace" text-anchor="end">${d1}</text>
    <text x="4" y="11" fill="#5c6675" font-size="10" font-family="monospace">★ ${entry.total.toLocaleString()} · ${note}</text>
  </svg>`
}
