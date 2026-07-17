// Collector: computes today's exact star-race leaderboard server-side so
// visitors need no token. Runs in GitHub Actions on a schedule with the
// built-in GITHUB_TOKEN; writes snapshot-out/today.json (pushed to the
// `data` branch by the workflow).
//
// Budget per run (GITHUB_TOKEN: ~1000 GraphQL points + 1000 REST req/hr):
// ~8 pass-1 queries + ≤150 pass-2 pages + 6 enrich queries + 6 REST calls.
const GH = 'https://api.github.com'
const TOKEN = process.env.GITHUB_TOKEN
if (!TOKEN) {
  console.error('GITHUB_TOKEN required')
  process.exit(1)
}
const H = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
}

async function rest(path) {
  const r = await fetch(GH + path, { headers: H })
  if (!r.ok) throw new Error(`${path} ${r.status}`)
  return r.json()
}
async function gql(query) {
  const r = await fetch(`${GH}/graphql`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ query }),
  })
  const j = await r.json()
  if (!j.data) throw new Error(JSON.stringify(j.errors || r.status).slice(0, 300))
  return j.data
}

// ---- 1. sample the public events firehose: candidates + recent-event feed ----
const eventCounts = new Map()
const recent = []
for (let p = 1; p <= 3; p++) { // the public events feed only exposes 300 events
  try {
    const evts = await rest(`/events?per_page=100&page=${p}`)
    for (const e of evts)
      if (e.type === 'WatchEvent') {
        eventCounts.set(e.repo.name, (eventCounts.get(e.repo.name) || 0) + 1)
        if (recent.length < 40)
          recent.push({ repo: e.repo.name, actor: e.actor.login, at: e.created_at })
      }
  } catch (e) {
    console.error('events', e.message)
  }
}

// ---- 2. more candidates: fresh-exploding repos + OSS Insight trending ----
let freshNew = []
try {
  const d = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10)
  const j = await rest(
    `/search/repositories?q=${encodeURIComponent(`created:>=${d} stars:>300`)}&sort=stars&order=desc&per_page=30`,
  )
  freshNew = j.items.map((r) => r.full_name)
} catch (e) {
  console.error('search', e.message)
}
let oss = []
try {
  const j = await (
    await fetch('https://api.ossinsight.io/v1/trends/repos/?period=past_24_hours')
  ).json()
  oss = j.data.rows.map((r) => r.repo_name)
} catch (e) {
  console.error('ossinsight', e.message)
}

const eventTop = [...eventCounts.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f)
const cands = [...new Set([...eventTop.slice(0, 50), ...freshNew, ...oss])].slice(0, 80)
console.log(`candidates: ${cands.length} (events ${eventTop.length}, fresh ${freshNew.length}, oss ${oss.length})`)

// ---- 3. exact stars since 00:00 UTC ----
const since = new Date().toISOString().slice(0, 10) + 'T00:00:00Z'
const results = {}
for (let i = 0; i < cands.length; i += 10) {
  const chunk = cands.slice(i, i + 10)
  const parts = chunk.map((full, j) => {
    const [o, n] = full.split('/')
    return `r${j}: repository(owner: ${JSON.stringify(o)}, name: ${JSON.stringify(n)}) {
      stargazerCount stargazers(last: 100) { edges { starredAt } pageInfo { startCursor hasPreviousPage } } }`
  })
  try {
    const data = await gql(`{ ${parts.join('\n')} }`)
    chunk.forEach((full, j) => {
      const r = data[`r${j}`]
      if (!r) return
      const edges = r.stargazers.edges
      const count = edges.filter((e) => e.starredAt >= since).length
      results[full] = {
        count,
        total: r.stargazerCount,
        more: count === edges.length && r.stargazers.pageInfo.hasPreviousPage,
        cursor: r.stargazers.pageInfo.startCursor,
        capped: false,
      }
    })
  } catch (e) {
    console.error('pass1', e.message)
  }
}

let pageBudget = 200
const deep = Object.entries(results)
  .filter(([, r]) => r.more)
  .sort(
    (a, b) =>
      (eventCounts.get(b[0]) || 0) - (eventCounts.get(a[0]) || 0) || b[1].total - a[1].total,
  )
for (const [full, r] of deep) {
  if (pageBudget <= 0) {
    r.capped = true
    continue
  }
  const [o, n] = full.split('/')
  let cursor = r.cursor
  let capped = true
  for (let p = 0; p < Math.min(80, pageBudget); p++) {
    try {
      const data = await gql(`{ repository(owner: ${JSON.stringify(o)}, name: ${JSON.stringify(n)}) {
        stargazers(last: 100, before: ${JSON.stringify(cursor)}) { edges { starredAt } pageInfo { startCursor hasPreviousPage } } } }`)
      const sg = data.repository?.stargazers
      if (!sg) break
      pageBudget--
      const c = sg.edges.filter((e) => e.starredAt >= since).length
      r.count += c
      if (c < sg.edges.length || !sg.pageInfo.hasPreviousPage) {
        capped = false
        break
      }
      cursor = sg.pageInfo.startCursor
    } catch (e) {
      console.error('pass2', full, e.message)
      break
    }
  }
  r.capped = capped
}

// ---- 4. enrich the top of the board ----
const ranked = Object.entries(results).sort((a, b) => b[1].count - a[1].count).slice(0, 100)
const meta = {}
const targets = ranked.slice(0, 60).map(([f]) => f)
for (let i = 0; i < targets.length; i += 10) {
  const chunk = targets.slice(i, i + 10)
  const parts = chunk.map((full, j) => {
    const [o, n] = full.split('/')
    return `r${j}: repository(owner: ${JSON.stringify(o)}, name: ${JSON.stringify(n)}) {
      description primaryLanguage { name color } repositoryTopics(first: 6) { nodes { topic { name } } } }`
  })
  try {
    const data = await gql(`{ ${parts.join('\n')} }`)
    chunk.forEach((full, j) => {
      const r = data[`r${j}`]
      if (!r) return
      meta[full] = {
        desc: r.description || '',
        lang: r.primaryLanguage?.name || '',
        langColor: r.primaryLanguage?.color || '',
        topics: r.repositoryTopics.nodes.map((n2) => n2.topic.name),
      }
    })
  } catch (e) {
    console.error('enrich', e.message)
  }
}

// ---- 5. write snapshot + accumulate history ----
// Layout of the data branch (SNAPSHOT_DIR):
//   today.json                    rolling current-day board (the app loads this)
//   history/YYYY-MM-DD.json       overwritten all day -> freezes as the day's final board
//   timeseries/YYYY-MM-DD.jsonl   one line per run: intra-day velocity of the top 30
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
const rows = ranked.map(([full, r]) => ({
  full,
  count: r.count,
  capped: r.capped,
  total: r.total,
  ...(meta[full] || {}),
}))
const dir = process.env.SNAPSHOT_DIR || 'snapshot-out'
const day = since.slice(0, 10)
const generatedAt = new Date().toISOString()
const snapshot = JSON.stringify({ generatedAt, since, rows, recentEvents: recent.slice(0, 30) })
mkdirSync(join(dir, 'history'), { recursive: true })
mkdirSync(join(dir, 'timeseries'), { recursive: true })
writeFileSync(join(dir, 'today.json'), snapshot)
writeFileSync(join(dir, 'history', `${day}.json`), snapshot)
appendFileSync(
  join(dir, 'timeseries', `${day}.jsonl`),
  JSON.stringify({
    t: generatedAt,
    rows: rows.slice(0, 30).map((r) => ({ f: r.full, c: r.count, x: r.capped ? 1 : 0 })),
  }) + '\n',
)
console.log(
  `snapshot: ${rows.length} rows, top: ${rows[0]?.full} +${rows[0]?.count}${rows[0]?.capped ? '+' : ''}, page budget left ${pageBudget}`,
)
