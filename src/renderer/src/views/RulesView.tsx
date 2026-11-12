import { useCallback, useEffect, useState } from 'react'
import type { RuleSummary, RuleVersionRecord } from '@shared/ipc.contract'

export default function RulesView({ onEdit }: { onEdit: (ruleId: string | null) => void }) {
  const [rules, setRules] = useState<RuleSummary[]>([])
  const [versions, setVersions] = useState<RuleVersionRecord[]>([])
  const [versionsFor, setVersionsFor] = useState<string | null>(null)
  const [error, setError] = useState('')

  const refresh = useCallback(() => {
    window.api.rule.list().then(setRules).catch((e) => setError(String(e)))
  }, [])

  useEffect(refresh, [refresh])

  const startRun = async (rule: RuleSummary) => {
    if (!rule.currentVersionId) return
    setError('')
    try {
      await window.api.run.start({ ruleVersionId: rule.currentVersionId })
      alert('任务已启动，切到「运行任务」查看进度')
    } catch (e) {
      setError(String(e))
    }
  }

  const remove = async (rule: RuleSummary) => {
    if (!confirm(`确定删除规则「${rule.name}」？历史数据保留。`)) return
    await window.api.rule.delete(rule.id)
    refresh()
  }

  const toggleVersions = async (rule: RuleSummary) => {
    if (versionsFor === rule.id) {
      setVersionsFor(null)
      return
    }
    setVersions(await window.api.rule.versions(rule.id))
    setVersionsFor(rule.id)
  }

  return (
    <div>
      <div className="row">
        <h2 style={{ margin: 0, flex: 1 }}>采集规则</h2>
        <button className="primary" onClick={() => onEdit(null)}>
          新建规则
        </button>
      </div>
      {error && <p className="muted">出错：{error}</p>}
      <div className="card">
        <table className="grid">
          <thead>
            <tr>
              <th>名称</th>
              <th>当前版本</th>
              <th>更新时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td>
                  <div>{r.name}</div>
                  {r.description && <div className="muted">{r.description}</div>}
                </td>
                <td>{r.versionNo ? `v${r.versionNo}` : '-'}</td>
                <td className="muted">{new Date(r.updatedAt).toLocaleString()}</td>
                <td>
                  <div className="row" style={{ marginBottom: 0 }}>
                    <button onClick={() => onEdit(r.id)}>编辑</button>
                    <button className="primary" disabled={!r.currentVersionId} onClick={() => void startRun(r)}>
                      运行
                    </button>
                    <button onClick={() => void toggleVersions(r)}>版本</button>
                    <button className="danger" onClick={() => void remove(r)}>
                      删除
                    </button>
                  </div>
                  {versionsFor === r.id && (
                    <table className="grid" style={{ marginTop: 8 }}>
                      <tbody>
                        {versions.map((v) => (
                          <tr key={v.id}>
                            <td>v{v.versionNo}</td>
                            <td className="muted">{new Date(v.createdAt).toLocaleString()}</td>
                            <td className="muted">{v.changeNote ?? ''}</td>
                            <td>
                              <button
                                onClick={() =>
                                  void window.api.run
                                    .start({ ruleVersionId: v.id })
                                    .then(() => alert('已用该历史版本启动任务'))
                                    .catch((e) => setError(String(e)))
                                }
                              >
                                用此版本运行
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </td>
              </tr>
            ))}
            {rules.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  还没有规则，点右上角「新建规则」开始。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
