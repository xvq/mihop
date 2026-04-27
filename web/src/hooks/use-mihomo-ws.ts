import { useEffect, useRef, useState } from "react"
import { auth, type MihomoConnectionsResp } from "@/lib/api"

function getWsBase(): string {
  if (import.meta.env.DEV) return "ws://localhost:8080"
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${proto}//${window.location.host}`
}

/**
 * 只有 mihomoRunning === true 时才建立 WebSocket 连接。
 * mihomo 未运行时直接返回 null，不会产生快速失败重试，
 * 避免触发 Chrome 对 WebSocket 的节流（~60 秒惩罚）。
 */
export function useMihomoConnections(mihomoRunning: boolean): MihomoConnectionsResp | null {
  const [data, setData] = useState<MihomoConnectionsResp | null>(null)
  const wsRef    = useRef<WebSocket | null>(null)
  const stopped  = useRef(false)

  useEffect(() => {
    if (!mihomoRunning) {
      // mihomo 停止时关闭现有连接，清空数据
      wsRef.current?.close()
      wsRef.current = null
      setData(null)
      return
    }

    stopped.current = false

    function connect() {
      if (stopped.current) return
      const tok = auth.getToken() ?? ""
      const ws = new WebSocket(`${getWsBase()}/api/mihomo/connections?token=${encodeURIComponent(tok)}`)
      wsRef.current = ws

      ws.onmessage = (ev: MessageEvent<string>) => {
        try {
          setData(JSON.parse(ev.data) as MihomoConnectionsResp)
        } catch { /* ignore malformed frames */ }
      }

      ws.onclose = () => {
        wsRef.current = null
        if (stopped.current) return
        // mihomo 在运行时断线才重连（3 秒），不会触发节流
        setTimeout(connect, 3_000)
      }

      ws.onerror = () => {
        ws.close()
      }
    }

    connect()

    return () => {
      stopped.current = true
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [mihomoRunning])

  return data
}
