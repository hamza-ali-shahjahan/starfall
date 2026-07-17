// The sky. Every node is a repo: size = stars gained (view-dependent),
// color = language, gold = your repos. Nodes cluster by language via a tiny
// force simulation; live star events arrive as shooting stars that flare
// their target. Plain canvas, no dependencies.

export function createGalaxy(canvas, { onHover, onClick, onZoom, rightGutter = () => 20, reservedRects = () => [] }) {
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

  // The layout cools like d3-force: forces scale with alpha, alpha decays to
  // zero, then stepping stops entirely and stars stay put so they're clickable.
  // Only a genuine layout change (new/removed stars, moved anchors, resize,
  // panels opening) reheats it — count/radius updates on every poll must not.
  const FIXED_DT = 16.7 // sim runs on a fixed step; frame rate must not change physics
  const ALPHA_DECAY = 0.022 // ~300 steps (~5s) to cool
  const ALPHA_MIN = 0.004
  let alpha = 1
  let settled = false

  function reheat(a = 1) {
    alpha = Math.max(alpha, a)
    settled = false
  }

  // Zoom is view-only: the sim always runs in unzoomed world coords, so magnifying
  // a constellation to read its names never disturbs the settled layout. Only the
  // canvas scales — the leaderboard and legend are DOM and stay put.
  const ZOOM_MIN = 1
  const ZOOM_MAX = 6
  let zoom = 1
  let panX = 0
  let panY = 0
  const toScreenX = (x) => x * zoom + panX
  const toScreenY = (y) => y * zoom + panY

  // Keep the field covering the viewport so it can't be dragged into empty space.
  function clampPan() {
    panX = Math.min(0, Math.max(W - W * zoom, panX))
    panY = Math.min(0, Math.max(H - H * zoom, panY))
  }

  // Zoom about a screen point so the star under the cursor stays under the cursor.
  function zoomAt(sx, sy, factor) {
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * factor))
    if (next === zoom) return
    const wx = (sx - panX) / zoom
    const wy = (sy - panY) / zoom
    zoom = next
    panX = sx - wx * zoom
    panY = sy - wy * zoom
    clampPan()
    onZoom?.(zoom)
  }

  function resetView() {
    zoom = 1
    panX = 0
    panY = 0
    onZoom?.(zoom)
  }

  function resize() {
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (!w || !h) return
    // ResizeObserver also fires with unchanged dimensions; only a real size change
    // moves the anchors, and only that is worth waking the sim back up for.
    const dimsChanged = w !== W || h !== H
    W = w
    H = h
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
    clampPan() // a resized viewport can leave the pan out of bounds
    if (dimsChanged) reheat()
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

  const anchorKey = () =>
    [...anchors].map(([c, a]) => `${c}:${a.x.toFixed(0)},${a.y.toFixed(0)}`).join('|')

  // list: [{id, r, color, cluster, label, gold, meta}]
  function setNodes(list) {
    const keep = new Set()
    let changed = false // membership or cluster moved — a pure count/radius tick must not reheat
    for (const d of list) {
      keep.add(d.id)
      const ex = nodes.get(d.id)
      if (ex) {
        if (ex.cluster !== d.cluster) changed = true
        Object.assign(ex, d)
      } else {
        nodes.set(d.id, { ...d, x: 0, y: 0, vx: 0, vy: 0, born: perf(), placed: false })
        changed = true
      }
    }
    for (const id of [...nodes.keys()])
      if (!keep.has(id)) {
        nodes.delete(id)
        changed = true
      }
    const anchorsBefore = anchorKey()
    layoutAnchors()
    placePending()
    if (changed || anchorKey() !== anchorsBefore) reheat()
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
  let cachedRects = []
  let cachedRectKey = ''
  let lastRectRefresh = 0
  let lastGutter = null
  let layoutSeen = false
  let acc = 0

  // Panels opening/closing and the board collapsing move stars, so this has to run
  // every frame even once the sim is asleep — otherwise a settled sky could never
  // notice a panel appeared on top of it.
  function watchLayout() {
    if (perf() - lastRectRefresh > 500) {
      const next = reservedRects()
      const key = next.map((r) => `${r.x | 0},${r.y | 0},${r.w | 0},${r.h | 0}`).join('|')
      if (layoutSeen && key !== cachedRectKey) reheat(0.5)
      cachedRectKey = key
      cachedRects = next
      lastRectRefresh = perf()
    }
    const gutter = rightGutter()
    if (gutter !== lastGutter) {
      if (layoutSeen) reheat(0.5)
      lastGutter = gutter
    }
    layoutSeen = true
  }

  // One fixed-size sim step. Never takes a frame delta: forces used to scale with
  // dt while damping and integration did not, so a slower frame injected energy it
  // never dissipated — at 30fps that made stars wander hundreds of px and never
  // settle, while a 120Hz display hid it completely.
  function step() {
    if (!W || !H) {
      resize()
      return
    }
    const arr = [...nodes.values()].filter((n) => n.placed)
    for (const n of arr) {
      const a = anchors.get(n.cluster) || { x: W / 2, y: H / 2 }
      n.vx += (a.x - n.x) * 0.0009 * FIXED_DT * alpha
      n.vy += (a.y - n.y) * 0.0009 * FIXED_DT * alpha
    }
    for (let i = 0; i < arr.length; i++)
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i], b = arr[j]
        const dx = b.x - a.x, dy = b.y - a.y
        const dist = Math.hypot(dx, dy) || 1
        const min = a.r + b.r + 22
        if (dist < min) {
          const f = ((min - dist) / dist) * 0.06 * FIXED_DT * alpha
          a.vx -= dx * f; a.vy -= dy * f
          b.vx += dx * f; b.vy += dy * f
        }
      }
    // soft repulsion out of DOM panel zones (legend, detail) so stars stay clickable
    for (const n of arr)
      for (const r of cachedRects) {
        if (n.x < r.x - n.r || n.x > r.x + r.w + n.r || n.y < r.y - n.r || n.y > r.y + r.h + n.r)
          continue
        const exitRight = r.x + r.w + n.r - n.x
        const exitLeft = n.x - (r.x - n.r)
        const exitDown = r.y + r.h + n.r - n.y
        const exitUp = n.y - (r.y - n.r)
        const min = Math.min(exitLeft, exitRight, exitUp, exitDown)
        const push = 0.08 * FIXED_DT * alpha
        if (min === exitRight) n.vx += push
        else if (min === exitLeft) n.vx -= push
        else if (min === exitDown) n.vy += push
        else n.vy -= push
      }

    const gutter = lastGutter ?? rightGutter()
    for (const n of arr) {
      n.vx *= 0.86; n.vy *= 0.86
      n.x += n.vx; n.y += n.vy
      // clamping position without killing velocity let stars grind along the edge
      const m = n.r + 10
      const loX = m + 6, hiX = W - gutter - m
      const loY = 64 + m, hiY = H - 48 - m - 16
      if (n.x < loX) { n.x = loX; n.vx = 0 } else if (n.x > hiX) { n.x = hiX; n.vx = 0 }
      if (n.y < loY) { n.y = loY; n.vy = 0 } else if (n.y > hiY) { n.y = hiY; n.vy = 0 }
    }

    alpha += (0 - alpha) * ALPHA_DECAY
    if (alpha < ALPHA_MIN) {
      alpha = 0
      settled = true
      for (const n of arr) { n.vx = 0; n.vy = 0 } // freeze: no creep, stars stay clickable
    }
  }

  function draw(now, frameDt = FIXED_DT) {
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
          ctx.moveTo(toScreenX(n.x), toScreenY(n.y))
          ctx.lineTo(toScreenX(best.x), toScreenY(best.y))
          ctx.stroke()
        }
      }
    }
    ctx.globalAlpha = 1

    for (const n of arr) {
      const tw = 0.85 + 0.15 * Math.sin(t * 1.7 + n.x)
      const sx = toScreenX(n.x), sy = toScreenY(n.y), sr = n.r * zoom
      ctx.globalAlpha = 0.09
      ctx.fillStyle = n.color
      ctx.beginPath()
      ctx.arc(sx, sy, sr * 2.1, 0, 6.29)
      ctx.fill()
      ctx.globalAlpha = 0.95 * tw
      ctx.beginPath()
      ctx.arc(sx, sy, sr, 0, 6.29)
      ctx.fill()
      ctx.globalAlpha = 1
      if (n === hovered) {
        ctx.strokeStyle = '#d8dee9'
        ctx.beginPath()
        ctx.arc(sx, sy, sr + 4, 0, 6.29)
        ctx.stroke()
      }
    }

    // greedy label pass: hovered > gold > biggest; skip anything that collides.
    // Text stays a fixed screen size, and the threshold is on the ON-SCREEN radius,
    // so zooming in is what reveals the smaller stars' names.
    ctx.font = '11px ui-monospace, monospace'
    ctx.lineWidth = 3
    ctx.strokeStyle = '#070910'
    const wantLabel = arr
      .filter((n) => n.r * zoom >= 11 || n.gold || n === hovered)
      .sort((a, b) => (b === hovered) - (a === hovered) || b.gold - a.gold || b.r - a.r)
    for (const n of wantLabel) {
      const label = n.label + (n.count ? ` ${n.count}` : '')
      const w = ctx.measureText(label).width
      const x = toScreenX(n.x) - w / 2
      const y = toScreenY(n.y) + n.r * zoom + 4
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
        const x = toScreenX(a.x) - w / 2
        const y = toScreenY(a.y) - 14
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
      s.t += frameDt
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
      ctx.moveTo(toScreenX(tx), toScreenY(ty))
      ctx.lineTo(toScreenX(hx), toScreenY(hy))
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
      f.t += frameDt
      const k = f.t / 700
      const n = nodes.get(f.id)
      if (!n || k >= 1) { flares.splice(i, 1); continue }
      ctx.globalAlpha = 0.8 * (1 - k)
      ctx.strokeStyle = f.color
      ctx.beginPath()
      ctx.arc(toScreenX(n.x), toScreenY(n.y), (n.r + 2 + k * 26) * zoom, 0, 6.29)
      ctx.stroke()
      ctx.globalAlpha = 1
    }
  }

  function loop() {
    const now = perf()
    const frameDt = Math.min(100, now - last)
    last = now
    watchLayout()
    // Fixed-step accumulator: 120Hz runs a step every other frame, 30Hz runs four
    // per frame, so the layout is identical on any display instead of only being
    // stable above ~90fps. Capped so a stalled tab can't spiral on resume.
    if (!settled) {
      acc = Math.min(acc + frameDt, FIXED_DT * 5)
      while (acc >= FIXED_DT) {
        step()
        acc -= FIXED_DT
      }
    } else {
      acc = 0
      if (!W || !H) resize()
    }
    draw(now, frameDt)
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)

  const screenOf = (ev) => {
    const rect = canvas.getBoundingClientRect()
    return { sx: ev.clientX - rect.left, sy: ev.clientY - rect.top }
  }

  function nodeAt(ev) {
    const { sx, sy } = screenOf(ev)
    // hit-test in world space, but with a screen-constant grab margin, so stars
    // stay exactly as easy to click at any zoom
    const x = (sx - panX) / zoom
    const y = (sy - panY) / zoom
    let best = null, bd = 1e9
    for (const n of nodes.values()) {
      const d = Math.hypot(n.x - x, n.y - y)
      if (d < n.r + 6 / zoom && d < bd) { bd = d; best = n }
    }
    return best
  }

  let drag = null
  let panned = false // set on mouseup, consumed by the click that follows it
  canvas.addEventListener('mousedown', (ev) => {
    panned = false
    if (nodeAt(ev)) return // let clicks on a star through
    const { sx, sy } = screenOf(ev)
    drag = { sx, sy, panX, panY, moved: false }
    canvas.style.cursor = 'grabbing'
  })
  addEventListener('mouseup', () => {
    panned = !!drag?.moved
    drag = null
    canvas.style.cursor = hovered ? 'pointer' : zoom > 1 ? 'grab' : 'default'
  })
  canvas.addEventListener('mousemove', (ev) => {
    if (drag) {
      const { sx, sy } = screenOf(ev)
      if (Math.hypot(sx - drag.sx, sy - drag.sy) > 3) drag.moved = true
      panX = drag.panX + (sx - drag.sx)
      panY = drag.panY + (sy - drag.sy)
      clampPan()
      onHover?.(null, 0, 0)
      return
    }
    hovered = nodeAt(ev)
    canvas.style.cursor = hovered ? 'pointer' : zoom > 1 ? 'grab' : 'default'
    onHover?.(hovered, ev.clientX, ev.clientY)
  })
  canvas.addEventListener('mouseleave', () => {
    hovered = null
    onHover?.(null, 0, 0)
  })
  canvas.addEventListener('click', (ev) => {
    if (panned) return // releasing a pan over a star is not a click on it
    const n = nodeAt(ev)
    if (n) onClick?.(n)
  })
  // wheel and trackpad pinch (which arrives as ctrl+wheel) both zoom the sky
  canvas.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault()
      const { sx, sy } = screenOf(ev)
      zoomAt(sx, sy, Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0015)))
    },
    { passive: false },
  )
  canvas.addEventListener('dblclick', (ev) => {
    const { sx, sy } = screenOf(ev)
    zoomAt(sx, sy, 1.8)
  })

  if (import.meta.env.DEV)
    window.__galaxy = {
      nodes, anchors,
      dims: () => ({ W, H }),
      sim: () => ({ alpha, settled }),
      view: () => ({ zoom, panX, panY }),
    }

  return {
    setNodes, impact, ambient,
    count: () => nodes.size,
    // zoom about the middle of the visible sky, left of the leaderboard
    zoomBy: (f) => zoomAt((W - rightGutter()) / 2, H / 2, f),
    resetView,
    getZoom: () => zoom,
  }
}
