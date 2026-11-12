import { useCallback, useEffect, useRef, useState } from 'react'
import type { RunSummary } from '@shared/ipc.contract'
import type { RunEvent } from '@shared/run.types'

interface LogLine {
  level: string
  step: string
  message: string
  at: string
}

export default function RunsView() {
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [logs, setLogs] = useState<LogLine[]>([])
  const [selectedRun, setSelectedRun] = useState<string | null>(null)
  const [error, setError] = useState('')
  const logEndRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(() => {
    window.api.run.list().then(setRuns).catch((e) => setError(String(e)))
  }, [])

  useEffect(() => {
    refresh()
    const off = window.api.run.onEvent((event: RunEvent) => {
      if (event.type === 'log') {
        setLogs((prev) => [...prev.slice(-400), { level: event.level, step: event.step, message: event.message, at: event.at }])
      }
      if (event.type === 'status' || event.type === 'progress') refresh()
    })
    const timer = setInterval(refresh, 5000)
    return () => {
      off()
      clearInterval(timer)
    }
  }, [refresh])

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  const act = async (fn: () => Promise<unknown>) => {
    setError('')
    try {
      await fn()
      refresh()
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>运行任务</h2>
      {error && <p className="muted">出错：{error}</p>}
      <div className="card">
        <table className="grid">
          <thead>
            <tr>
              <th>状态</th>
              <th>触发</th>
              <th>进度</th>
              <th>开始时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} onClick={() => setSelectedRun(r.id)} style={{ cursor: 'pointer' }}>
                <td>
                  <span className={`badge ${r.status}`}>{statusLabel(r.status)}</span>
                  {r.errorSummary && <div className="muted">{r.errorSummary}</div>}
                </td>
                <td className="muted">{r.trigger === 'resume' ? '续跑' : r.trigger === 'manual' ? '手动' : '定时'}</td>
                <td className="muted">
                  {r.stats
                    ? `第${r.stats.pagesProcessed}页 · 提取${r.stats.rowsExtracted} · 入库${r.stats.rowsUpserted} · 失败${r.stats.rowsFailed}`
                    : '-'}
                </td>
                <td className="muted">{r.startedAt ? new Date(r.startedAt).toLocaleString() : '-'}</td>
                <td>
                  <div className="row" style={{ marginBottom: 0 }}>
                    {(r.status === 'running' || r.status === 'paused_login') && (
                      <button className="danger" onClick={() => void act(() => window.api.run.stop(r.id))}>
                        停止
                      </button>
                    )}
                    {r.status === 'paused_login' && (
                      <button className="primary" onClick={() => void act(() => window.api.run.continueLogin(r.id))}>
                        已重新登录，继续
                      </button>
                    )}
                    {(r.status === 'stopped' || r.status === 'error') && (
                      <button className="primary" onClick={() => void act(() => window.api.run.resume(r.id))}>
                        续跑
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {runs.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  还没有运行记录，到「采集规则」里点运行。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>运行日志{selectedRun ? `（${selectedRun.slice(-6)}）` : '（最近）'}</h3>
        <div className="log-list">
          {logs.map((l, i) => (
            <div key={i} className={l.level}>
              [{l.at.slice(11, 19)}] [{l.step}] {l.message}
            </div>
          ))}
          {logs.length === 0 && <div className="muted">暂无日志</div>}
          <div ref={logEndRef} />
        </div>
      </div>
    </div>
  )
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    idle: '空闲',
    queued: '排队中',
    running: '运行中',
    stopping: '停止中',
    stopped: '已停止',
    paused_login: '待重新登录',
    error: '出错',
    done: '完成'
  }
  return map[status] ?? status
}
