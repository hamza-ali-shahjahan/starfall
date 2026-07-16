// The sky. Every node is a repo: size = stars gained (view-dependent),
// color = language, gold = your repos. Nodes cluster by language via a tiny
// force simulation; live star events arrive as shooting stars that flare
// their target. Plain canvas, no dependencies.

export function createGalaxy(canvas, { onHover, onClick, rightGutter = () => 20, reservedRects = () => [] }) {
  const ctx = canvas.getContext('2d')
  let W = 0
  let H = 0
  let dpr = Math.min(devicePixelRatio || 1, 2)

  const nodes = new Map() // id -> node
  const anchors = new Map() // cluster -> {x,y}
  const shots = [] // shooting stars
  const flares = []
  const bgStars = []
  let hovered = null

  function resize() {
    W = canvas.clientWidth
    H = canvas.clientHeight
    if (!W || !H) return
    canvas.width = W * dpr
    canvas.height = H * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (bgStars.length === 0)
      for (let i = 0; i < 220; i++)
        bgStars.push({
          x: Math.random(), y: Math.random(),
          r: 0.4 + Math.random() * 0.9,
          phase: Math.random() * 6.28,
          speed: 0.3 + Math.random() * 0.8,
        })
    layoutAnchors()
    placePending()
  }

  function placePending() {
    if (!W || !H) return
    for (const n of nodes.values())
      if (!n.placed) {
        const a = anchors.get(n.cluster) || { x: W / 2, y: H / 2 }
        n.x = a.x + (Math.random() - 0.5) * 90
        n.y = a.y + (Math.random() - 0.5) * 90
        n.placed = true
      }
  }
  new ResizeObserver(resize).observe(canvas)
  resize()

  const GOLDEN = 2.39996
  function layoutAnchors() {
    const clusters = [...new Set([...nodes.values()].map((n) => n.cluster))].filter((c) => c !== '@you')
    clusters.sort()
    anchors.clear()
    const usableW = W - rightGutter()
    const cx = usableW * 0.5
    const cy = H * 0.5
    clusters.forEach((c, i) => {
      const a = i * GOLDEN
      const rad = (0.16 + 0.1 * ((i % 3) + 1)) * Math.min(usableW, H)
      anchors.set(c, {
        x: Math.max(80, Math.min(usableW - 80, cx + Math.cos(a) * rad * 1.15)),
        y: Math.max(110, Math.min(H - 110, cy + Math.sin(a) * rad * 0.85)),
      })
    })
    anchors.set('@you', { x: Math.max(80, usableW * 0.14), y: H * 0.74 })
  }

  // list: [{id, r, color, cluster, label, gold, meta}]
  function setNodes(list) {
    const keep = new Set()
    for (const d of list) {
      keep.add(d.id)
      const ex = nodes.get(d.id)
      if (ex) Object.assign(ex, d)
      else nodes.set(d.id, { ...d, x: 0, y: 0, vx: 0, vy: 0, born: perf(), placed: false })
    }
    for (const id of [...nodes.keys()]) if (!keep.has(id)) nodes.delete(id)
    layoutAnchors()
    placePending()
  }

  function impact(id, color) {
    const n = nodes.get(id)
    if (!n) return false
    const side = Math.floor(Math.random() * 3)
    const sx = side === 0 ? Math.random() * W : side === 1 ? -20 : W + 20
    const sy = side === 0 ? -20 : Math.random() * H * 0.7
    shots.push({ sx, sy, id, t: 0, dur: 500 + Math.random() * 300, color: color || '#fff' })
    return true
  }

  function ambient() {
    const sx = Math.random() * W
    shots.push({ sx, sy: -10, x1: sx + 60 + Math.random() * 120, y1: Math.random() * H * 0.5, t: 0, dur: 420, color: '#8899bb', ambient: true })
  }

  const perf = () => performance.now()
  let last = perf()

  function step(dt) {
    if (!W || !H) {
      resize()
      return
    }
    const arr = [...nodes.values()].filter((n) => n.placed)
    for (const n of arr) {
      const a = anchors.get(n.cluster) || { x: W / 2, y: H / 2 }
      n.vx += (a.x - n.x) * 0.0009 * dt
      n.vy += (a.y - n.y) * 0.0009 * dt
    }
    for (let i = 0; i < arr.length; i++)
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i], b = arr[j]
        const dx = b.x - a.x, dy = b.y - a.y
        const dist = Math.hypot(dx, dy) || 1
        const min = a.r + b.r + 22
        if (dist < min) {
          const f = ((min - dist) / dist) * 0.06 * dt
          a.vx -= dx * f; a.vy -= dy * f
          b.vx += dx * f; b.vy += dy * f
        }
      }
    const gutter = rightGutter()
    for (const n of arr) {
      n.vx *= 0.86; n.vy *= 0.86
      n.x += n.vx; n.y += n.vy
      const m = n.r + 10
      n.x = Math.max(m + 6, Math.min(W - gutter - m, n.x))
      n.y = Math.max(64 + m, Math.min(H - 48 - m - 16, n.y))
    }
  }

  function draw(now) {
    ctx.clearRect(0, 0, W, H)
    const t = now / 1000
    for (const s of bgStars) {
      ctx.globalAlpha = 0.25 + 0.2 * Math.sin(t * s.speed + s.phase)
      ctx.fillStyle = '#5c7192'
      ctx.beginPath()
      ctx.arc(s.x * W, s.y * H, s.r, 0, 6.29)
      ctx.fill()
    }
    ctx.globalAlpha = 1

    // cluster labels + constellation lines to nearest same-cluster neighbor
    const arr = [...nodes.values()].filter((n) => n.placed)
    const byCluster = new Map()
    for (const n of arr) {
      if (!byCluster.has(n.cluster)) byCluster.set(n.cluster, [])
      byCluster.get(n.cluster).push(n)
    }
    const drawnLabels = [...reservedRects()]
    const gutter = rightGutter()
    const fits = (x, y, w, h) => {
      if (x < 4 || x + w > W - gutter || y < 64 || y > H - 50) return false
      for (const r of drawnLabels)
        if (x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y) return false
      return true
    }

    for (const [, list] of byCluster) {
      for (const n of list) {
        let best = null, bd = 1e9
        for (const m of list) {
          if (m === n) continue
          const d = (m.x - n.x) ** 2 + (m.y - n.y) ** 2
          if (d < bd) { bd = d; best = m }
        }
        if (best && bd < 200 * 200) {
          ctx.globalAlpha = n.gold ? 0.3 : 0.12
          ctx.strokeStyle = n.color
          ctx.beginPath()
          ctx.moveTo(n.x, n.y)
          ctx.lineTo(best.x, best.y)
          ctx.stroke()
        }
      }
    }
    ctx.globalAlpha = 1

    for (const n of arr) {
      const tw = 0.85 + 0.15 * Math.sin(t * 1.7 + n.x)
      ctx.globalAlpha = 0.09
      ctx.fillStyle = n.color
      ctx.beginPath()
      ctx.arc(n.x, n.y, n.r * 2.1, 0, 6.29)
      ctx.fill()
      ctx.globalAlpha = 0.95 * tw
      ctx.beginPath()
      ctx.arc(n.x, n.y, n.r, 0, 6.29)
      ctx.fill()
      ctx.globalAlpha = 1
      if (n === hovered) {
        ctx.strokeStyle = '#d8dee9'
        ctx.beginPath()
        ctx.arc(n.x, n.y, n.r + 4, 0, 6.29)
        ctx.stroke()
      }
    }

    // greedy label pass: hovered > gold > biggest; skip anything that collides
    ctx.font = '11px ui-monospace, monospace'
    ctx.lineWidth = 3
    ctx.strokeStyle = '#070910'
    const wantLabel = arr
      .filter((n) => n.r >= 11 || n.gold || n === hovered)
      .sort((a, b) => (b === hovered) - (a === hovered) || b.gold - a.gold || b.r - a.r)
    for (const n of wantLabel) {
      const label = n.label + (n.count ? ` ${n.count}` : '')
      const w = ctx.measureText(label).width
      const x = n.x - w / 2
      const y = n.y + n.r + 4
      if (!fits(x, y, w, 13) && n !== hovered) continue
      ctx.strokeText(label, x, y + 11)
      ctx.fillStyle = n.gold ? '#e8b33d' : '#93a4bd'
      ctx.fillText(label, x, y + 11)
      drawnLabels.push({ x, y, w, h: 13 })
    }

    // cluster labels drawn ABOVE stars with a dark halo; node labels won first
    ctx.font = '10px ui-monospace, monospace'
    for (const [c, list] of byCluster) {
      if (list.length >= 3 && c !== '@you') {
        const a = anchors.get(c)
        if (!a) continue
        const label = `${c.toUpperCase()} · ${list.length}`
        const w = ctx.measureText(label).width
        const x = a.x - w / 2
        const y = a.y - 14
        if (!fits(x, y, w, 12)) continue
        ctx.strokeText(label, x, y + 10)
        ctx.fillStyle = '#7d8db0'
        ctx.fillText(label, x, y + 10)
        drawnLabels.push({ x, y, w, h: 12 })
      }
    }
    ctx.lineWidth = 1

    if (arr.length === 0) {
      ctx.fillStyle = '#5c6675'
      ctx.font = '12px ui-monospace, monospace'
      const msg = 'empty sky — stars appear as events arrive'
      ctx.fillText(msg, (W - gutter) / 2 - ctx.measureText(msg).width / 2, H / 2)
    }

    for (let i = shots.length - 1; i >= 0; i--) {
      const s = shots[i]
      s.t += 16.7
      const k = Math.min(1, s.t / s.dur)
      const target = s.ambient ? { x: s.x1, y: s.y1 } : nodes.get(s.id)
      if (!target) { shots.splice(i, 1); continue }
      const hx = s.sx + (target.x - s.sx) * k
      const hy = s.sy + (target.y - s.sy) * k
      const tx = s.sx + (target.x - s.sx) * Math.max(0, k - 0.13)
      const ty = s.sy + (target.y - s.sy) * Math.max(0, k - 0.13)
      ctx.globalAlpha = s.ambient ? 0.5 : 0.9
      ctx.strokeStyle = s.color
      ctx.lineWidth = 1.4
      ctx.beginPath()
      ctx.moveTo(tx, ty)
      ctx.lineTo(hx, hy)
      ctx.stroke()
      ctx.lineWidth = 1
      ctx.globalAlpha = 1
      if (k >= 1) {
        shots.splice(i, 1)
        if (!s.ambient) flares.push({ id: s.id, t: 0, color: s.color })
      }
    }

    for (let i = flares.length - 1; i >= 0; i--) {
      const f = flares[i]
      f.t += 16.7
      const k = f.t / 700
      const n = nodes.get(f.id)
      if (!n || k >= 1) { flares.splice(i, 1); continue }
      ctx.globalAlpha = 0.8 * (1 - k)
      ctx.strokeStyle = f.color
      ctx.beginPath()
      ctx.arc(n.x, n.y, n.r + 2 + k * 26, 0, 6.29)
      ctx.stroke()
      ctx.globalAlpha = 1
    }
  }

  function loop() {
    const now = perf()
    const dt = Math.min(40, now - last)
    last = now
    step(dt)
    draw(now)
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)

  function nodeAt(ev) {
    const rect = canvas.getBoundingClientRect()
    const x = ev.clientX - rect.left
    const y = ev.clientY - rect.top
    let best = null, bd = 1e9
    for (const n of nodes.values()) {
      const d = Math.hypot(n.x - x, n.y - y)
      if (d < n.r + 6 && d < bd) { bd = d; best = n }
    }
    return best
  }
  canvas.addEventListener('mousemove', (ev) => {
    hovered = nodeAt(ev)
    canvas.style.cursor = hovered ? 'pointer' : 'grab'
    onHover?.(hovered, ev.clientX, ev.clientY)
  })
  canvas.addEventListener('mouseleave', () => {
    hovered = null
    onHover?.(null, 0, 0)
  })
  canvas.addEventListener('click', (ev) => {
    const n = nodeAt(ev)
    if (n) onClick?.(n)
  })

  if (import.meta.env.DEV) window.__galaxy = { nodes, anchors, dims: () => ({ W, H }) }

  return { setNodes, impact, ambient, count: () => nodes.size }
}
