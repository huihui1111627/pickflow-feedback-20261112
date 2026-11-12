import { useCallback, useEffect, useState } from 'react'
import type { DataPage, TaskSummary } from '@shared/ipc.contract'

const PAGE_SIZE = 50

export default function DataView() {
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  const [taskId, setTaskId] = useState('')
  const [page, setPage] = useState(0)
  const [data, setData] = useState<DataPage | null>(null)
  const [message, setMessage] = useState('')

  useEffect(() => {
    window.api.run.listTasks().then(setTasks).catch((e) => setMessage(String(e)))
  }, [])

  const load = useCallback(() => {
    if (!taskId) return
    window.api.data
      .query({ taskId, limit: PAGE_SIZE, offset: page * PAGE_SIZE })
      .then(setData)
      .catch((e) => setMessage(String(e)))
  }, [taskId, page])

  useEffect(load, [load])

  const doExport = async (format: 'csv' | 'json') => {
    setMessage('')
    try {
      const result = await window.api.exporter.start(taskId, format)
      setMessage(`已导出：${result.path}`)
    } catch (e) {
      setMessage(`导出失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const columns = data && data.rows.length > 0 ? Array.from(new Set(data.rows.flatMap((r) => Object.keys(r.data)))) : []

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>数据与导出</h2>
      {message && <p className="muted">{message}</p>}
      <div className="card">
        <div className="row">
          <select
            value={taskId}
            onChange={(e) => {
              setTaskId(e.target.value)
              setPage(0)
            }}
            style={{ minWidth: 280 }}
          >
            <option value="">选择任务…</option>
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.ruleName}（v{t.versionNo ?? '?'} · {t.resultCount} 条）
              </option>
            ))}
          </select>
          <button disabled={!taskId} onClick={() => void doExport('csv')}>
            导出 CSV
          </button>
          <button disabled={!taskId} onClick={() => void doExport('json')}>
            导出 JSON
          </button>
          <span className="muted">每条数据都带来源页面地址，导出文件含 _source_url 列</span>
        </div>

        {data && (
          <>
            <table className="grid">
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                  <th>来源</th>
                  <th>采集时间</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    {columns.map((c) => (
                      <td key={c}>{formatCell(r.data[c])}</td>
                    ))}
                    <td>
                      <a href={r.sourceUrl} target="_blank" rel="noreferrer" className="mono">
                        来源页
                      </a>
                    </td>
                    <td className="muted">{new Date(r.collectedAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row" style={{ marginTop: 10 }}>
              <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                上一页
              </button>
              <span className="muted">
                第 {page + 1} 页 / 共 {data.total} 条
              </span>
              <button disabled={(page + 1) * PAGE_SIZE >= data.total} onClick={() => setPage((p) => p + 1)}>
                下一页
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
