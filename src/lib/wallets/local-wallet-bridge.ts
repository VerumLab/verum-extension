const FRAME_URL = 'ws://localhost:1248'

let frameWs: WebSocket | undefined
let nextId = 1
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

function getSocket(): Promise<WebSocket> {
  if (frameWs?.readyState === WebSocket.OPEN) return Promise.resolve(frameWs)

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(FRAME_URL)

    const timer = setTimeout(() => { ws.close(); reject(new Error('Frame connection timeout')) }, 500)

    ws.onopen = () => {
      clearTimeout(timer)
      frameWs = ws

      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data as string)
        if (msg.id == null) return
        const cb = pending.get(msg.id)
        if (!cb) return
        pending.delete(msg.id)
        if (msg.error) cb.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
        else cb.resolve(msg.result)
      }

      ws.onclose = () => {
        if (frameWs === ws) frameWs = undefined
        // Defer so any response message that arrived in the same tick is processed first.
        setTimeout(() => {
          for (const cb of pending.values()) cb.reject(new Error('Frame disconnected'))
          pending.clear()
        }, 0)
      }

      resolve(ws)
    }

    ws.onerror = () => { clearTimeout(timer); reject(new Error('Frame not running')) }
  })
}

export async function isFrameAvailable(): Promise<boolean> {
  try { await getSocket(); return true } catch { return false }
}

export async function frameRequest(method: string, params: unknown[]): Promise<unknown> {
  const ws = await getSocket()
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
}
