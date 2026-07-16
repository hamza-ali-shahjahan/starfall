import './style.css'
import {
  pollEvents, enrichRepos, getToken, setToken, rateRemaining,
  fetchViewer, fetchOwnRepos, fetchRecentStargazers,
  fetchOssTrending, searchRepos, starsSinceBatch, starsSincePages,
} from './api.js'
import { state, loadDay, maybeRollover, ingest, top, tierOf, topicCounts } from './state.js'
import { createGalaxy } from './galaxy.js'
import { fetchStarHistory, historyChartSvg } from './history.js'

const $ = (id) => document.getElementById(id)
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const LANG_COLORS = {
  python: '#3572A5', typescript: '#3178c6', javascript: '#f1e05a', rust: '#dea584',
  go: '#00ADD8', 'c++': '#f34b7d', c: '#8f8f8f', java: '#b07219', kotlin: '#A97BFF',
  swift: '#F05138', ruby: '#e05252', php: '#7e6bb3', 'c#': '#2fb350', shell: '#89e051',
  html: '#e34c26', css: '#8557c5', 'jupyter notebook': '#DA5B0B', dart: '#00B4AB',
  zig: '#ec915c', lua: '#5c6bc0', vue: '#41b883', dockerfile: '#7a8ba1', powershell: '#4f74a8',
}
const langColorOf = (lang, fallback) => LANG_COLORS[(lang || '').toLowerCase()] || fallback || '#7d8aa0'

let galaxy = null
let pollTimer = null
let consecutiveErrors = 0
const watchlist = new Set(JSON.parse(localStorage.getItem('starfall.watch') || '[]'))
const pinned = new Map() // full -> {lang, desc, total} from searches this session

// ---------- header ----------
function renderClock() {
  const now = new Date()
  $('clock').textContent = now.toISOString().slice(11, 19) + ' UTC'
  const n = state.totalStarsToday
  $('day-stats').textContent = `${state.date} · ${n.toLocaleString()} star${n === 1 ? '' : 's'} seen today`
}
setInterval(renderClock, 1000)

function syncBarHeight() {
  document.documentElement.style.setProperty('--bar-h', $('bar').offsetHeight + 8 + 'px')
}
new ResizeObserver(syncBarHeight).observe(document.getElementById('bar'))

function setBadge(mode, resetAt) {
  const b = $('live-badge')
  if (mode === 'live') {
    b.className = 'badge'
    b.textContent = `● LIVE${getToken() ? '' : ' · NO TOKEN'}`
  } else if (mode === 'ratelimited') {
    const hhmm = new Date(resetAt).toTimeString().slice(0, 5)
    b.className = 'badge ratelimited'
    b.textContent = `● RATE-LIMITED · resumes ${hhmm}`
  } else {
    b.className = 'badge offline'
    b.textContent = '● OFFLINE · retrying'
  }
}

// ---------- ticker ----------
function pushTicker(e, gold = false) {
  $('ticker').querySelector('.placeholder')?.remove()
  const div = document.createElement('div')
  div.className = 'ev' + (gold ? ' gold' : '')
  div.innerHTML = `<span class="star">★</span> <b>${esc(e.repo.name)}</b> ← ${esc(e.actor.login)}`
  const t = $('ticker')
  t.prepend(div)
  while (t.children.length > 14) t.lastChild.remove()
}

const ago = (iso) => {
  const s = (Date.now() - new Date(iso)) / 1000
  if (s < 3600) return `${Math.max(1, (s / 60) | 0)}m ago`
  if (s < 86400) return `${(s / 3600) | 0}h ago`
  return `${(s / 86400) | 0}d ago`
}

// ---------- views ----------
const trend = {
  view: 'auto',
  lang: '',
  period: '7',
  customDate: '',
  today: new Map(),
  week: [],
  alltime: [],
  weekFetched: 0,
  alltimeFetched: 0,
  refreshing: false,
}

function risingSince() {
  if (trend.period === 'custom' && trend.customDate) return trend.customDate
  const days = Number(trend.period) || 7
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10)
}

function viewSub() {
  const labels = { 7: 'the last 7 days', 30: 'the last 30 days', 90: 'the last 3 months' }
  return {
    auto: 'exact stars gained since 00:00 UTC · refreshes every 10 min',
    live: 'star events witnessed while this sky is open',
    week: `repos born ${trend.period === 'custom' ? `since ${risingSince()}` : `in ${labels[trend.period]}`} · by total stars`,
    alltime: 'the all-time most-starred repositories',
  }[trend.view]
}

const VIEW_TITLE = {
  auto: "TODAY'S STARFALL",
  live: 'THIS SESSION',
  week: 'RISING',
  alltime: 'ALL-TIME GIANTS',
}

function activeRows() {
  let rows
  if (trend.view === 'live') {
    rows = top(100).map(([full, n]) => {
      const m = state.meta.get(full) || {}
      return { full, n, prefix: '+', suffix: '', lang: m.lang, langColor: m.langColor, desc: m.desc, total: m.stars, tier: tierOf(full) }
    })
  } else if (trend.view === 'auto') {
    rows = [...trend.today.entries()]
      .map(([full, e]) => ({
        full, n: e.count, prefix: '+',
        suffix: e.capped ? '+' : e.pending ? '…' : '',
        lang: e.lang, desc: e.desc, total: e.total,
      }))
      .sort((a, b) => (b.n ?? -1) - (a.n ?? -1))
      .slice(0, 100)
  } else {
    rows = (trend.view === 'week' ? trend.week : trend.alltime).map((r) => ({
      full: r.full, n: r.total, prefix: '★ ', suffix: '', lang: r.lang, desc: r.desc, total: r.total,
    }))
  }
  if (trend.lang) rows = rows.filter((r) => (r.lang || '').toLowerCase() === trend.lang.toLowerCase())
  return rows
}

const fmtCount = (r) => (r.n == null ? '—' : `${r.prefix}${r.n.toLocaleString()}${r.suffix}`)

// ---------- leaderboard panel ----------
function renderBoard(rows) {
  $('board-title').textContent = VIEW_TITLE[trend.view]
  $('board-sub').textContent =
    trend.view === 'auto' && !getToken()
      ? 'candidates only — add a token (⚙) for exact daily counts'
      : viewSub()
  $('board').innerHTML = rows
    .map((r, i) => {
      const [owner, name] = r.full.split('/')
      const tierLabel = r.tier && { fresh: 'DEBUT', streak: 'ON A ROLL', returning: 'ENCORE' }[r.tier]
      return `<div class="board-row" data-repo="${esc(r.full)}">
        <span class="board-rank">${String(i + 1).padStart(2, '0')}</span>
        <div class="board-repo">
          <span class="full">${esc(owner)}/<b>${esc(name)}</b></span>
          <span class="sub">
            ${r.lang ? `<span class="lang-dot" style="--c:${langColorOf(r.lang, r.langColor)}"></span>${esc(r.lang)}` : ''}
            ${tierLabel ? `<span class="tier ${r.tier}">${tierLabel}</span>` : ''}
          </span>
        </div>
        <span class="board-today">${fmtCount(r)}</span>
      </div>`
    })
    .join('')
}

// ---------- the sky ----------
let lastSkyNodes = []
function updateSky(rows) {
  const skyRows = rows.slice(0, 90)
  const max = Math.max(...skyRows.map((r) => r.n || 0), 1)
  const nodes = skyRows.map((r) => ({
    id: r.full,
    r: r.n == null ? 3 : 3 + 22 * Math.sqrt(r.n / max),
    color: langColorOf(r.lang, r.langColor),
    cluster: (r.lang || 'other').toLowerCase(),
    label: r.full.split('/')[1],
    count: fmtCount(r),
    gold: false,
  }))
  const present = new Set(nodes.map((n) => n.id))
  for (const [full, meta] of [...pinned, ...[...watchlist].map((f) => [f, state.meta.get(f) || {}])]) {
    if (present.has(full)) continue
    present.add(full)
    nodes.push({
      id: full, r: 5, color: langColorOf(meta.lang), cluster: (meta.lang || 'other').toLowerCase(),
      label: full.split('/')[1], count: '', gold: false,
    })
  }
  for (const r of mine.repos) {
    if (present.has(r.full)) continue
    nodes.push({
      id: r.full,
      r: Math.max(4, Math.min(11, 4 + Math.sqrt(r.stars))),
      color: '#e8b33d', cluster: '@you', label: r.name,
      count: `★ ${r.stars}`, gold: true,
    })
  }
  lastSkyNodes = nodes
  galaxy?.setNodes(nodes)
}

function renderLegend() {
  const sizeNote = { auto: '(today)', live: '(this session)', week: '(total)', alltime: '(total)' }[trend.view]
  $('legend-sizenote').textContent = sizeNote
  // count from the actual sky nodes so legend always matches cluster labels
  const counts = new Map()
  let yours = 0
  for (const n of lastSkyNodes) {
    if (n.cluster === '@you') {
      yours++
      continue
    }
    counts.set(n.cluster, (counts.get(n.cluster) || 0) + 1)
  }
  const topLangs = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  $('legend-langs').innerHTML =
    topLangs
      .map(
        ([lang, n]) =>
          `<span class="lg-lang"><span class="lang-dot" style="--c:${langColorOf(lang)}"></span>${esc(lang)} <em>${n}</em></span>`,
      )
      .join('') +
    (yours ? `<span class="lg-lang"><span class="lang-dot" style="--c:var(--gold)"></span>yours <em>${yours}</em></span>` : '')
  $('legend-note').textContent =
    !getToken() && trend.view === 'auto'
      ? 'counts show — without a token · click ⚙ to add one'
      : ''
}

function renderView() {
  const rows = activeRows()
  renderBoard(rows)
  updateSky(rows)
  renderLegend()
  $('period-filter').hidden = trend.view !== 'week'
  $('since-date').hidden = trend.view !== 'week' || trend.period !== 'custom'
}
$('legend-toggle').addEventListener('click', () => {
  const body = $('legend-body')
  body.hidden = !body.hidden
  $('legend-toggle').textContent = body.hidden ? '+' : '–'
  localStorage.setItem('starfall.legend', body.hidden ? '0' : '1')
})
if (localStorage.getItem('starfall.legend') === '0') {
  $('legend-body').hidden = true
  $('legend-toggle').textContent = '+'
}

// ---------- TOP TODAY ----------
async function refreshToday() {
  if (trend.refreshing) return
  trend.refreshing = true
  try {
    const fortnightAgo = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10)
    const [oss, freshNew] = await Promise.all([
      fetchOssTrending('past_24_hours').catch(() => []),
      searchRepos(`created:>=${fortnightAgo} stars:>300`, 30).catch(() => []),
    ])
    const metaByFull = new Map([...oss, ...freshNew].map((r) => [r.full, r]))
    const cands = [
      ...new Set([
        ...top(50).map(([f]) => f),
        ...freshNew.map((r) => r.full),
        ...oss.map((r) => r.full),
        ...watchlist,
      ]),
    ].slice(0, 80)
    if (!getToken()) {
      trend.today = new Map(
        [...freshNew, ...oss].map((r) => [r.full, { count: null, lang: r.lang, desc: r.desc }]),
      )
      if (trend.view === 'auto') renderView()
      return
    }
    if (rateRemaining !== null && rateRemaining < 800) return
    const since = state.date + 'T00:00:00Z'
    const results = {}
    for (let i = 0; i < cands.length; i += 10)
      Object.assign(results, await starsSinceBatch(cands.slice(i, i + 10), since))
    const map = new Map()
    for (const [full, r] of Object.entries(results)) {
      const om = metaByFull.get(full)
      const m = state.meta.get(full)
      map.set(full, {
        count: r.count, capped: false, pending: r.more, total: r.total,
        lang: om?.lang || m?.lang || '', desc: om?.desc || m?.desc || '',
      })
      if (!m)
        state.meta.set(full, {
          desc: om?.desc || '', lang: om?.lang || '', langColor: '',
          stars: r.total, topics: [], fetchedAt: Date.now(),
        })
    }
    trend.today = map
    if (trend.view === 'auto') renderView()
    let pageBudget = 120
    const deep = Object.entries(results)
      .filter(([, r]) => r.more)
      .sort(
        (a, b) =>
          (state.counts.get(b[0]) || 0) - (state.counts.get(a[0]) || 0) || b[1].total - a[1].total,
      )
    for (const [full, r] of deep) {
      const e = map.get(full)
      if (pageBudget <= 0) {
        e.capped = true
        e.pending = false
        continue
      }
      const { added, capped, pagesUsed } = await starsSincePages(full, r.cursor, since, Math.min(30, pageBudget))
      pageBudget -= pagesUsed
      e.count += added
      e.capped = capped
      e.pending = false
      if (trend.view === 'auto') renderView()
    }
  } finally {
    trend.refreshing = false
  }
}

async function ensureSearchView(view) {
  const cacheKey = `${view}|${trend.lang}|${view === 'week' ? risingSince() : ''}`
  if (trend.cacheKey === cacheKey && Date.now() - trend[view + 'Fetched'] < 3600_000 && trend[view].length)
    return
  trend.cacheKey = cacheKey
  const langQ = trend.lang ? ` language:"${trend.lang}"` : ''
  const q = view === 'week' ? `created:>=${risingSince()} stars:>100${langQ}` : `stars:>50000${langQ}`
  const rows = await searchRepos(q, 50)
  trend[view] = rows
  trend[view + 'Fetched'] = Date.now()
  for (const r of rows)
    if (!state.meta.has(r.full))
      state.meta.set(r.full, { desc: r.desc, lang: r.lang, langColor: '', stars: r.total, topics: [], fetchedAt: Date.now() })
  if (trend.view === view) renderView()
}

// ---------- filters ----------
for (const b of document.querySelectorAll('#view-tabs button'))
  b.addEventListener('click', () => {
    trend.view = b.dataset.view
    document.querySelectorAll('#view-tabs button').forEach((x) => x.classList.toggle('on', x === b))
    closeDetail()
    if (trend.view === 'week' || trend.view === 'alltime') ensureSearchView(trend.view)
    renderView()
  })
$('lang-filter').addEventListener('change', () => {
  trend.lang = $('lang-filter').value
  if (trend.view === 'week' || trend.view === 'alltime') ensureSearchView(trend.view)
  renderView()
})
$('period-filter').addEventListener('change', () => {
  trend.period = $('period-filter').value
  if (trend.period !== 'custom') ensureSearchView('week')
  renderView()
})
$('since-date').addEventListener('change', () => {
  trend.customDate = $('since-date').value
  if (trend.customDate) ensureSearchView('week')
  renderView()
})
$('board-toggle').addEventListener('click', () => {
  const p = $('board-panel')
  p.classList.toggle('collapsed')
  $('board-toggle').textContent = p.classList.contains('collapsed') ? '+' : '–'
})

// ---------- topics ----------
function renderTopics() {
  const tc = topicCounts()
  $('topics').innerHTML = tc.length
    ? tc
        .slice(0, 18)
        .map(([t, n], i) => `<span class="topic${i < 3 ? ' hot' : ''}">#${esc(t)}<span class="n">${n}</span></span>`)
        .join('')
    : `<span class="muted">${getToken() ? 'collecting…' : 'add a token to see topics'}</span>`
}

// ---------- hovercard ----------
const card = $('hovercard')
function showCard(full, x, y, extra) {
  const m = state.meta.get(full)
  const t = trend.today.get(full)
  const desc = m?.desc || t?.desc
  const lang = m?.lang || t?.lang
  const total = m?.stars ?? t?.total
  const n = trend.view === 'auto' ? t?.count : state.counts.get(full)
  card.innerHTML =
    `<h4>${esc(full)}</h4>` +
    (desc ? `<div class="desc">${esc(desc)}</div>` : '') +
    `<div class="meta">
      ${n != null ? `<span class="gold">+${n.toLocaleString()} today</span>` : ''}
      ${total != null ? `<span>★ ${total.toLocaleString()} total</span>` : ''}
      ${lang ? `<span>${esc(lang)}</span>` : ''}
      ${extra ? `<span>${esc(extra)}</span>` : ''}
    </div>`
  card.hidden = false
  card.style.left = Math.min(x + 14, innerWidth - 340) + 'px'
  card.style.top = Math.min(y + 14, innerHeight - card.offsetHeight - 46) + 'px'
}
document.addEventListener('mousemove', (ev) => {
  const row = ev.target.closest?.('[data-repo]')
  if (row) showCard(row.dataset.repo, ev.clientX, ev.clientY)
  else if (!ev.target.closest('#sky')) card.hidden = true
})
document.addEventListener('click', (ev) => {
  const row = ev.target.closest?.('[data-repo]')
  if (row) openDetail(row.dataset.repo)
})

// ---------- detail panel ----------
let detailFor = null
async function openDetail(full) {
  detailFor = full
  const m = state.meta.get(full) || {}
  const t = trend.today.get(full)
  const desc = m.desc || t?.desc || ''
  const lang = m.lang || t?.lang || ''
  const total = m.stars ?? t?.total
  const todayN = t?.count ?? state.counts.get(full)
  $('detail-name').textContent = full
  $('detail-desc').textContent = desc
  $('detail-meta').innerHTML =
    `${todayN != null ? `<span class="gold">+${todayN.toLocaleString()} today</span>` : ''}` +
    `${total != null ? `<span>★ ${total.toLocaleString()} total</span>` : ''}` +
    `${lang ? `<span><span class="lang-dot" style="--c:${langColorOf(lang)};display:inline-block;margin-right:4px"></span>${esc(lang)}</span>` : ''}`
  $('detail-topics').innerHTML = (m.topics || []).map((tp) => `<span class="topic">#${esc(tp)}</span>`).join('')
  $('detail-link').href = `https://github.com/${full}`
  updateTrackBtn()
  $('detail-chart').innerHTML = `<span class="muted">crawling star history…</span>`
  $('detail').hidden = false
  card.hidden = true
  try {
    const entry = await fetchStarHistory(full, total)
    if (detailFor === full) $('detail-chart').innerHTML = historyChartSvg(entry)
  } catch (err) {
    if (detailFor !== full) return
    $('detail-chart').innerHTML = `<span class="muted">${
      err.rateLimited
        ? 'rate budget spent — history will work again within the hour'
        : getToken()
          ? 'history unavailable right now — try again shortly'
          : 'history needs a few API calls — add a token (⚙) or try again shortly'
    }</span>`
  }
}
function updateTrackBtn() {
  const b = $('detail-track')
  const on = watchlist.has(detailFor)
  b.textContent = on ? '★ tracked' : '☆ track this repo'
  b.className = 'btn' + (on ? ' tracked' : '')
}
$('detail-track').addEventListener('click', () => {
  if (!detailFor) return
  if (watchlist.has(detailFor)) watchlist.delete(detailFor)
  else watchlist.add(detailFor)
  localStorage.setItem('starfall.watch', JSON.stringify([...watchlist]))
  updateTrackBtn()
  renderView()
})
function closeDetail() {
  $('detail').hidden = true
  detailFor = null
}
$('detail-close').addEventListener('click', closeDetail)

// ---------- search ----------
let searchTimer = null
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer)
  const q = $('search').value.trim()
  if (q.length < 2) {
    $('search-results').hidden = true
    return
  }
  searchTimer = setTimeout(async () => {
    const rows = await searchRepos(`${q} in:name`, 8).catch(() => [])
    const box = $('search-results')
    if (!rows.length) {
      box.hidden = true
      return
    }
    box.innerHTML = rows
      .map((r) => `<div class="sr" data-full="${esc(r.full)}"><span class="n">${esc(r.full)}</span><span class="s">★ ${r.total.toLocaleString()}</span></div>`)
      .join('')
    box.hidden = false
    for (const el of box.querySelectorAll('.sr'))
      el.addEventListener('click', () => {
        const full = el.dataset.full
        const r = rows.find((x) => x.full === full)
        if (r && !state.meta.has(full))
          state.meta.set(full, { desc: r.desc, lang: r.lang, langColor: '', stars: r.total, topics: [], fetchedAt: Date.now() })
        pinned.set(full, r || {})
        box.hidden = true
        $('search').value = ''
        renderView()
        openDetail(full)
      })
  }, 350)
})
document.addEventListener('click', (ev) => {
  if (!ev.target.closest('#searchbox')) $('search-results').hidden = true
})

// ---------- your constellation ----------
const mine = { login: null, repos: [], gazers: [], loaded: false }

async function refreshMine() {
  if (!mine.login) {
    const v = await fetchViewer()
    if (!v) return
    mine.login = v.login
  }
  const all = await fetchOwnRepos()
  const totalStars = all.reduce((s, r) => s + r.stars, 0)
  mine.repos = all.sort((a, b) => b.stars - a.stars).slice(0, 8)
  const lists = await Promise.all(
    mine.repos.slice(0, 3).map((r) =>
      fetchRecentStargazers(r.full, 8).then((g) => g.map((x) => ({ ...x, repo: r.name }))),
    ),
  )
  const merged = lists.flat().sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 8)
  if (mine.loaded) {
    const known = new Set(mine.gazers.map((g) => g.login + '·' + g.repo))
    for (const g of merged.filter((x) => !known.has(x.login + '·' + x.repo))) {
      pushTicker({ repo: { name: `YOU/${g.repo}` }, actor: { login: g.login } }, true)
      galaxy?.impact(mine.repos.find((r) => r.name === g.repo)?.full, '#e8b33d')
    }
  }
  mine.gazers = merged
  mine.loaded = true
  $('mine-panel').hidden = false
  $('mine-total').textContent = `@${mine.login} · ★ ${totalStars.toLocaleString()}`
  $('mine-gazers').innerHTML = mine.gazers
    .map(
      (g) => `<a class="gazer" href="https://github.com/${esc(g.login)}" target="_blank" rel="noopener"
        title="${esc(g.login)} starred ${esc(g.repo)} · ${ago(g.at)}">
        <img src="${esc(g.avatar)}&s=48" alt="" loading="lazy" /><span>${esc(g.login)}</span></a>`,
    )
    .join('')
  renderView()
}

async function mineLoop() {
  while (true) {
    if (getToken()) {
      try {
        await refreshMine()
      } catch {}
    } else {
      $('mine-panel').hidden = true
      mine.login = null
      mine.loaded = false
      mine.repos = []
    }
    await sleep(60_000)
  }
}

// ---------- enrichment ----------
async function enrichLoop() {
  while (true) {
    await sleep(30_000)
    if (!getToken()) continue
    const now = Date.now()
    const need = [...new Set([...top(40).map(([f]) => f), ...activeRows().slice(0, 30).map((r) => r.full)])]
      .filter((full) => {
        const m = state.meta.get(full)
        return !m || !m.topics?.length || now - m.fetchedAt > 5 * 60_000
      })
      .slice(0, 30)
    if (!need.length) continue
    try {
      const found = await enrichRepos(need)
      for (const [full, m] of Object.entries(found)) state.meta.set(full, { ...m, fetchedAt: now })
      renderView()
      renderTopics()
    } catch {}
  }
}

// ---------- poll loop ----------
function pollInterval() {
  return getToken() ? 5_000 : 60_000
}

async function tick() {
  try {
    if (maybeRollover()) {
      trend.today.clear()
      renderView()
      renderTopics()
      refreshToday()
    }
    const { events, notModified } = await pollEvents()
    setBadge('live')
    consecutiveErrors = 0
    $('events-meta').textContent = rateRemaining !== null ? `${rateRemaining} req/hr left` : ''
    if (!notModified) {
      const fresh = ingest(events)
      for (const e of fresh.slice(0, 8)) pushTicker(e)
      for (const e of fresh) {
        const t = trend.today.get(e.repo.name)
        if (t && t.count != null && !t.pending) t.count++
        if (!galaxy?.impact(e.repo.name, '#cfd8e6') && Math.random() < 0.12) galaxy?.ambient()
      }
      if (fresh.length) {
        renderView()
        renderClock()
      }
    }
  } catch (err) {
    consecutiveErrors++
    if (err.rateLimited) {
      setBadge('ratelimited', err.resetAt)
      const hhmm = new Date(err.resetAt).toTimeString().slice(0, 5)
      $('events-meta').textContent = `rate budget spent · resumes ${hhmm}`
      pollTimer = setTimeout(tick, Math.max(pollInterval(), err.resetAt - Date.now() + 5_000))
      return
    }
    setBadge('offline')
    console.warn('poll failed:', err)
  }
  const backoff = Math.min(consecutiveErrors, 5) * 10_000
  pollTimer = setTimeout(tick, pollInterval() + backoff)
}

// ---------- token chip ----------
function updateTokenChip() {
  $('token-chip').hidden = !!getToken() || localStorage.getItem('starfall.chipoff') === '1'
}
$('token-chip').addEventListener('click', () => $('settings').showModal())
$('token-chip-x').addEventListener('click', (e) => {
  e.stopPropagation()
  localStorage.setItem('starfall.chipoff', '1')
  updateTokenChip()
})

// ---------- settings ----------
$('settings-btn').addEventListener('click', () => {
  $('token-input').value = getToken()
  $('settings').showModal()
})
$('settings').addEventListener('close', () => {
  const v = $('settings').returnValue
  if (v === 'save') setToken($('token-input').value)
  if (v === 'clear') setToken('')
  $('token-input').value = ''
  if (v === 'save' || v === 'clear') {
    updateTokenChip()
    clearTimeout(pollTimer)
    tick()
    renderTopics()
    refreshToday().catch(() => {})
    if (getToken()) refreshMine().catch(() => {})
    else {
      $('mine-panel').hidden = true
      mine.login = null
      mine.loaded = false
      mine.repos = []
    }
  }
})

// ---------- loops & boot ----------
async function refreshTodayLoop() {
  let first = true
  while (true) {
    try {
      await refreshToday()
    } catch {}
    await sleep(first ? 2 * 60_000 : 10 * 60_000)
    first = false
  }
}

function boot() {
  loadDay()
  galaxy = createGalaxy($('sky'), {
    rightGutter() {
      const p = $('board-panel')
      return p && !p.hidden && !p.classList.contains('collapsed') ? 356 : 24
    },
    reservedRects() {
      const rects = []
      for (const id of ['left-stack', 'detail']) {
        const el = $(id)
        if (el && !el.hidden) {
          const r = el.getBoundingClientRect()
          if (r.width) rects.push({ x: r.left - 6, y: r.top - 6, w: r.width + 12, h: r.height + 12 })
        }
      }
      return rects
    },
    onHover(node, x, y) {
      if (node) showCard(node.id, x, y, node.gold ? 'yours ✦' : '')
      else card.hidden = true
    },
    onClick(node) {
      openDetail(node.id)
    },
  })
  renderClock()
  renderView()
  renderTopics()
  $('ticker').innerHTML = `<div class="ev placeholder">listening for star events…${getToken() ? '' : ' (no token · polls every 60s)'}</div>`
  if (!getToken() && !localStorage.getItem('starfall.seen')) {
    $('settings').showModal()
    localStorage.setItem('starfall.seen', '1')
  }
  updateTokenChip()
  tick()
  enrichLoop()
  mineLoop()
  refreshTodayLoop()
}
boot()

// dev-only: simulate star events from the console to exercise the UI
if (import.meta.env.DEV) {
  window.__starfall = {
    openDetail,
    simulate(n = 50) {
      const repos = ['acme/rocket', 'foo/bar-ai', 'octo/tools', 'zen/notes', 'dev/kit', 'ml/lab']
      const langs = ['Python', 'TypeScript', 'Rust', 'Go', 'Python', 'JavaScript']
      repos.forEach((full, i) => {
        if (!state.meta.has(full))
          state.meta.set(full, { desc: 'simulated repo', lang: langs[i], langColor: '', stars: 1000 * (i + 1), topics: ['sim'], fetchedAt: Date.now() })
      })
      const events = Array.from({ length: n }, (_, i) => ({
        id: 'sim' + Date.now() + i,
        type: 'WatchEvent',
        created_at: new Date().toISOString(),
        actor: { login: 'user' + ((Math.random() * 900) | 0) },
        repo: { name: repos[(Math.random() * repos.length) | 0] },
      }))
      // never persist simulated events — in-memory visual test only
      const fresh = ingest(events, false)
      for (const e of fresh.slice(0, 8)) pushTicker(e)
      renderView()
      for (const e of fresh.slice(0, 25)) setTimeout(() => galaxy?.impact(e.repo.name, '#cfd8e6'), Math.random() * 3000)
    },
  }
}
