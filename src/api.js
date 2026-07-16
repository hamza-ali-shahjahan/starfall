// All GitHub API access. Token lives only in localStorage ('starfall.token').

const API = 'https://api.github.com'

export function getToken() {
  return localStorage.getItem('starfall.token') || ''
}
export function setToken(t) {
  if (t) localStorage.setItem('starfall.token', t.trim())
  else localStorage.removeItem('starfall.token')
}

export function headers() {
  const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  const t = getToken()
  if (t) h.Authorization = `Bearer ${t}`
  return h
}

const etags = new Map()
export let rateRemaining = null

// Poll the public events firehose. WatchEvents are sparse and unevenly spread
// across pages, so authenticated mode reads 3 pages per tick.
// Returns { events: WatchEvent[], notModified }.
export async function pollEvents() {
  const pages = getToken() ? [1, 2, 3] : [1]
  const results = await Promise.all(
    pages.map(async (p) => {
      const url = `${API}/events?per_page=100&page=${p}`
      const h = headers()
      if (etags.has(url)) h['If-None-Match'] = etags.get(url)
      const res = await fetch(url, { headers: h })
      rateRemaining = Number(res.headers.get('x-ratelimit-remaining') ?? rateRemaining)
      if (res.status === 304) return null
      if (res.status === 403 || res.status === 429) {
        const err = new Error('rate-limited')
        err.rateLimited = true
        err.resetAt = Number(res.headers.get('x-ratelimit-reset')) * 1000 || Date.now() + 15 * 60_000
        throw err
      }
      if (!res.ok) throw new Error(`events ${res.status}`)
      etags.set(url, res.headers.get('etag'))
      return res.json()
    }),
  )
  const live = results.filter(Boolean)
  if (live.length === 0) return { events: [], notModified: true }
  return {
    events: live.flat().filter((e) => e.type === 'WatchEvent'),
    notModified: false,
  }
}

// Cached user profile lookups (login -> location string). Persisted, capped.
const USER_CACHE_KEY = 'starfall.users'
const userCache = JSON.parse(localStorage.getItem(USER_CACHE_KEY) || '{}')
let userCacheDirty = 0

export async function fetchUserLocation(login) {
  if (login in userCache) return userCache[login]
  const res = await fetch(`${API}/users/${encodeURIComponent(login)}`, { headers: headers() })
  if (!res.ok) return (userCache[login] = null)
  const u = await res.json()
  userCache[login] = u.location || null
  if (++userCacheDirty % 20 === 0) {
    const keys = Object.keys(userCache)
    if (keys.length > 4000) for (const k of keys.slice(0, 1000)) delete userCache[k]
    localStorage.setItem(USER_CACHE_KEY, JSON.stringify(userCache))
  }
  return userCache[login]
}

// OSS Insight public trending list — used only as a CANDIDATE source (their
// selection is good; their star counts are sampled, so we recount exactly).
export async function fetchOssTrending(period = 'past_24_hours') {
  const res = await fetch(`https://api.ossinsight.io/v1/trends/repos/?period=${period}`)
  if (!res.ok) return []
  const { data } = await res.json()
  return data.rows.map((r) => ({
    full: r.repo_name,
    lang: r.primary_language || '',
    desc: r.description || '',
  }))
}

// GitHub repo search, stars-descending.
export async function searchRepos(q, perPage = 50) {
  const res = await fetch(
    `${API}/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${perPage}`,
    { headers: headers() },
  )
  if (!res.ok) return []
  const { items } = await res.json()
  return items.map((r) => ({
    full: r.full_name,
    total: r.stargazers_count,
    lang: r.language || '',
    desc: r.description || '',
  }))
}

// Pass 1 of exact "+stars since" counting: one batched GraphQL query reads the
// last 100 star timestamps for up to ~10 repos at once.
export async function starsSinceBatch(fulls, sinceIso) {
  if (!getToken() || fulls.length === 0) return {}
  const parts = fulls.map((full, i) => {
    const [o, n] = full.split('/')
    return `r${i}: repository(owner: ${JSON.stringify(o)}, name: ${JSON.stringify(n)}) {
      stargazerCount stargazers(last: 100) {
        edges { starredAt } pageInfo { startCursor hasPreviousPage } } }`
  })
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ query: `{ ${parts.join('\n')} }` }),
  })
  if (!res.ok) return {}
  const { data } = await res.json()
  const out = {}
  fulls.forEach((full, i) => {
    const r = data?.[`r${i}`]
    if (!r) return
    const edges = r.stargazers.edges
    const count = edges.filter((e) => e.starredAt >= sinceIso).length
    out[full] = {
      count,
      total: r.stargazerCount,
      more: count === edges.length && r.stargazers.pageInfo.hasPreviousPage,
      cursor: r.stargazers.pageInfo.startCursor,
    }
  })
  return out
}

// Pass 2: for repos whose entire last-100 page was inside the window, keep
// paging backwards until we cross sinceIso or hit maxPages.
export async function starsSincePages(full, cursor, sinceIso, maxPages = 30) {
  const [o, n] = full.split('/')
  let added = 0
  let capped = true
  let pagesUsed = 0
  for (let p = 0; p < maxPages; p++) {
    const q = `{ repository(owner: ${JSON.stringify(o)}, name: ${JSON.stringify(n)}) {
      stargazers(last: 100, before: ${JSON.stringify(cursor)}) {
        edges { starredAt } pageInfo { startCursor hasPreviousPage } } } }`
    const res = await fetch(`${API}/graphql`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ query: q }),
    })
    if (!res.ok) break
    const sg = (await res.json()).data?.repository?.stargazers
    if (!sg) break
    pagesUsed++
    const c = sg.edges.filter((e) => e.starredAt >= sinceIso).length
    added += c
    if (c < sg.edges.length || !sg.pageInfo.hasPreviousPage) {
      capped = false
      break
    }
    cursor = sg.pageInfo.startCursor
  }
  return { added, capped, pagesUsed }
}

// Who does the saved token belong to?
export async function fetchViewer() {
  const res = await fetch(`${API}/user`, { headers: headers() })
  return res.ok ? res.json() : null
}

// The viewer's own public non-fork repos with star counts.
export async function fetchOwnRepos() {
  const res = await fetch(`${API}/user/repos?per_page=100&type=owner`, { headers: headers() })
  if (!res.ok) return []
  const repos = await res.json()
  return repos
    .filter((r) => !r.fork && !r.private)
    .map((r) => ({ full: r.full_name, name: r.name, stars: r.stargazers_count }))
}

// Most recent stargazers of a repo (star+json gives starred_at; the list is
// oldest-first, so jump to the last page via the Link header).
export async function fetchRecentStargazers(full, n = 8) {
  const h = { ...headers(), Accept: 'application/vnd.github.star+json' }
  const base = `${API}/repos/${full}/stargazers?per_page=30`
  let res = await fetch(base, { headers: h })
  if (!res.ok) return []
  const last = res.headers.get('link')?.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/)
  if (last) {
    res = await fetch(`${base}&page=${last[1]}`, { headers: h })
    if (!res.ok) return []
  }
  const arr = await res.json()
  return arr
    .slice(-n)
    .reverse()
    .map((s) => ({ login: s.user.login, avatar: s.user.avatar_url, at: s.starred_at }))
}

// Batch-enrich repos via one GraphQL query (needs a token).
// names: ["owner/repo", ...] -> { "owner/repo": {desc, lang, langColor, stars, topics[]} }
export async function enrichRepos(names) {
  if (!getToken() || names.length === 0) return {}
  const parts = names.map((full, i) => {
    const [owner, name] = full.split('/')
    return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
      description stargazerCount primaryLanguage { name color }
      repositoryTopics(first: 6) { nodes { topic { name } } } }`
  })
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ query: `{ ${parts.join('\n')} }` }),
  })
  if (!res.ok) return {}
  const { data } = await res.json()
  const out = {}
  names.forEach((full, i) => {
    const r = data?.[`r${i}`]
    if (!r) return
    out[full] = {
      desc: r.description || '',
      lang: r.primaryLanguage?.name || '',
      langColor: r.primaryLanguage?.color || '',
      stars: r.stargazerCount,
      topics: r.repositoryTopics.nodes.map((n) => n.topic.name),
    }
  })
  return out
}
