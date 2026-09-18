// Tiny "game" for the error panel. The Ethereum-diamond rocket.
let raf = 0
let mounted: HTMLDivElement | null = null
let teardown: (() => void) | null = null

const W = 360
const H = 460
const SHIP_Y = H / 2
const SHIP_R = 13
const MOVE = 4.6
const GRACE_MS = 3000
const RESTART_MS = 1200

interface Obst { x: number; y: number; w: number; h: number; passed: boolean }

export function startRocketGame(container: HTMLElement): void {
  if (mounted) return

  const box = document.createElement('div')
  box.id = 'rocket-game'
  box.innerHTML =
    '<canvas width="' + W + '" height="' + H + '"></canvas>' +
    '<div class="rg-bar">' +
      '<span class="rg-hint">← → to dodge · any arrow to start</span>' +
      '<button class="rg-restart" hidden>↻ Restart</button>' +
    '</div>'
  container.insertBefore(box, container.firstChild)
  mounted = box

  const canvas = box.querySelector('canvas') as HTMLCanvasElement
  const restartBtn = box.querySelector('.rg-restart') as HTMLButtonElement
  const ctx = canvas.getContext('2d')!

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = W * dpr
  canvas.height = H * dpr
  ctx.scale(dpr, dpr)

  let x = W / 2
  let vx = 0
  let obstacles: Obst[] = []
  let spawn = 0
  let score = 0
  let best = 0
  let startedAt = 0
  let overAt = 0
  let state: 'ready' | 'play' | 'over' = 'ready'
  const keys = { left: false, right: false }
  const canRestart = () => state === 'over' && performance.now() - overAt > RESTART_MS
  try { best = parseInt(localStorage.getItem('rg-best') || '0', 10) || 0 } catch { /* private mode */ }

  function reset() {
    x = W / 2; vx = 0; obstacles = []; spawn = 0; score = 0
    startedAt = performance.now(); state = 'play'
    restartBtn.hidden = true
  }

  function onKey(e: KeyboardEvent, down: boolean) {
    const left = e.code === 'ArrowLeft', right = e.code === 'ArrowRight'
    const anyArrow = left || right || e.code === 'ArrowUp' || e.code === 'ArrowDown'
    if (!anyArrow) return
    e.preventDefault()
    if (left) keys.left = down
    if (right) keys.right = down
    if (down && (state === 'ready' || canRestart())) reset()
  }
  const kd = (e: KeyboardEvent) => onKey(e, true)
  const ku = (e: KeyboardEvent) => onKey(e, false)
  window.addEventListener('keydown', kd)
  window.addEventListener('keyup', ku)
  restartBtn.addEventListener('click', () => { if (canRestart()) reset() })

  function drawEth(cx: number, cy: number, s: number, tilt: number) {
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(tilt)
    const topY = -s * 1.6, midY = -s * 0.15, waistY = s * 0.55, botY = s * 1.6
    const face = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, c: string) => {
      ctx.fillStyle = c; ctx.beginPath()
      ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3); ctx.closePath(); ctx.fill()
    }
    // abstract flames (behind the diamond, flickering)
    const jt = () => (Math.random() - 0.5) * s * 0.5
    const flame = (spread: number, len: number, c: string) => {
      ctx.fillStyle = c; ctx.beginPath()
      ctx.moveTo(-s * spread, botY * 0.72)
      ctx.lineTo(s * spread, botY * 0.72)
      ctx.lineTo(jt(), botY * 0.72 + len)
      ctx.closePath(); ctx.fill()
    }
    flame(0.7, s * (1.7 + Math.random()), '#ff7a3d')
    flame(0.5, s * (1.3 + Math.random()), '#ffb24d')
    flame(0.28, s * (0.9 + Math.random() * 0.7), '#8ab4ff')
    face(0, topY, -s, midY, 0, waistY, '#c9d3f0')
    face(0, topY, s, midY, 0, waistY, '#8b98d6')
    face(0, botY, -s, midY, 0, waistY, '#8b98d6')
    face(0, botY, s, midY, 0, waistY, '#62688f')
    ctx.restore()
  }

  function tick() {
    // ---- update ----
    if (state === 'play') {
      const elapsed = performance.now() - startedAt
      vx = (keys.right ? MOVE : 0) - (keys.left ? MOVE : 0)
      x = Math.max(SHIP_R, Math.min(W - SHIP_R, x + vx))

      // Difficulty ramps with elapsed time: faster fall, tighter spawn.
      const diff = elapsed / 1000
      const fall = 2.4 + diff * 0.18
      const interval = Math.max(34, 90 - diff * 3)

      if (elapsed > GRACE_MS) {
        spawn--
        if (spawn <= 0) {
          const w = 34 + Math.random() * 60
          obstacles.push({ x: Math.random() * (W - w), y: -30, w, h: 22, passed: false })
          spawn = interval
        }
      }
      for (const o of obstacles) o.y += fall
      obstacles = obstacles.filter(o => o.y < H + 30)

      for (const o of obstacles) {
        if (!o.passed && o.y > SHIP_Y + SHIP_R) { o.passed = true; score++ }
        const hit = x + SHIP_R * 0.7 > o.x && x - SHIP_R * 0.7 < o.x + o.w &&
                    SHIP_Y + SHIP_R * 0.9 > o.y && SHIP_Y - SHIP_R * 0.9 < o.y + o.h
        if (hit) gameOver()
      }
    }

    // ---- draw ----
    ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, W, H)
    ctx.fillStyle = '#1b2230'
    for (let i = 0; i < 24; i++) ctx.fillRect((i * 53) % W, (i * 97) % H, 2, 2)

    for (const o of obstacles) {
      ctx.fillStyle = '#161b22'; ctx.strokeStyle = '#30363d'; ctx.lineWidth = 2
      roundRect(ctx, o.x, o.y, o.w, o.h, 8); ctx.fill(); ctx.stroke()
    }

    drawEth(x, SHIP_Y, 12, Math.max(-0.4, Math.min(0.4, vx * 0.06)))

    ctx.fillStyle = '#c9d3f0'; ctx.font = 'bold 22px -apple-system, sans-serif'; ctx.textAlign = 'center'
    ctx.fillText(String(score), W / 2, 40)

    if (state === 'play' && performance.now() - startedAt <= GRACE_MS) {
      ctx.fillStyle = '#8b949e'; ctx.font = '14px -apple-system, sans-serif'
      ctx.fillText('Get ready…', W / 2, 66)
    }
    if (state === 'ready') {
      overlay('Fly the diamond', 'Press ← or → to launch')
    } else if (state === 'over') {
      const ready = canRestart()
      restartBtn.disabled = !ready
      overlay('Game Over', 'Score ' + score + '   ·   Best ' + best +
        (ready ? '\nArrow key or Restart to retry' : '\n…'))
    }

    raf = requestAnimationFrame(tick)
  }

  function overlay(title: string, sub: string) {
    ctx.fillStyle = 'rgba(13,17,23,0.68)'; ctx.fillRect(0, 0, W, H)
    ctx.fillStyle = '#c9d3f0'; ctx.textAlign = 'center'
    ctx.font = 'bold 26px -apple-system, sans-serif'
    ctx.fillText(title, W / 2, H * 0.34)
    ctx.fillStyle = '#8b949e'; ctx.font = '14px -apple-system, sans-serif'
    sub.split('\n').forEach((line, i) => ctx.fillText(line, W / 2, H * 0.34 + 30 + i * 22))
  }

  function gameOver() {
    if (state !== 'play') return
    state = 'over'
    overAt = performance.now()
    restartBtn.hidden = false
    if (score > best) { best = score; try { localStorage.setItem('rg-best', String(best)) } catch { /* ignore */ } }
  }

  raf = requestAnimationFrame(tick)

  teardown = () => {
    cancelAnimationFrame(raf); raf = 0
    window.removeEventListener('keydown', kd)
    window.removeEventListener('keyup', ku)
  }
}

export function stopRocketGame(): void {
  if (teardown) { teardown(); teardown = null }
  if (mounted) { mounted.remove(); mounted = null }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
