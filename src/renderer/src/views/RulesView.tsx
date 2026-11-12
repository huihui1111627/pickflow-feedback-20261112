import { useCallback, useEffect, useState } from 'react'
import type { RuleSummary, RuleVersionRecord } from '@shared/ipc.contract'

type ScheduleConf = { cron: string; timezone: string; enabled: boolean }

export default function RulesView({ onEdit }: { onEdit: (ruleId: string | null) => void }) {
  const [rules, setRules] = useState<RuleSummary[]>([])
  const [versions, setVersions] = useState<RuleVersionRecord[]>([])
  const [versionsFor, setVersionsFor] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [scheduleFor, setScheduleFor] = useState<RuleSummary | null>(null)

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
                    <button disabled={!r.currentVersionId} onClick={() => setScheduleFor(r)}>
                      定时
                    </button>
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

      {scheduleFor && (
        <ScheduleDialog
          rule={scheduleFor}
          onClose={() => setScheduleFor(null)}
          onError={setError}
        />
      )}
    </div>
  )
}

const CRON_PRESETS: { label: string; expr: string }[] = [
  { label: '每小时', expr: '0 * * * *' },
  { label: '每天 9 点', expr: '0 9 * * *' },
  { label: '工作日 9 点', expr: '0 9 * * 1-5' },
  { label: '每周一 9 点', expr: '0 9 * * 1' },
  { label: '每月 1 号 9 点', expr: '0 9 1 * *' }
]

function ScheduleDialog({ rule, onClose, onError }: { rule: RuleSummary; onClose: () => void; onError: (s: string) => void }) {
  const [taskId, setTaskId] = useState('')
  const [conf, setConf] = useState<ScheduleConf | null>(null)
  const [cronInput, setCronInput] = useState('0 9 * * *')
  const [timezone, setTimezone] = useState('local')
  const [enabled, setEnabled] = useState(true)
  const [hint, setHint] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const { taskId: tid } = await window.api.run.ensure(rule.currentVersionId!)
        setTaskId(tid)
        const existing = await window.api.run.getSchedule(tid)
        if (existing) {
          setConf(existing)
          setCronInput(existing.cron)
          setTimezone(existing.timezone)
          setEnabled(existing.enabled)
        }
      } catch (e) {
        onError(String(e))
      }
    })()
  }, [rule, onError])

  const save = async () => {
    setHint('')
    try {
      const valid = await window.api.run.validateCron(cronInput.trim())
      if (!valid) {
        setHint('cron 表达式不合法，标准 5 段：分 时 日 月 周')
        return
      }
      await window.api.run.setSchedule(taskId, { cron: cronInput.trim(), timezone, enabled })
      setConf({ cron: cronInput.trim(), timezone, enabled })
      setHint(enabled ? '已保存并启用，下个到点自动运行' : '已保存但处于停用状态')
    } catch (e) {
      setHint(e instanceof Error ? e.message : String(e))
    }
  }

  const clear = async () => {
    await window.api.run.setSchedule(taskId, null)
    setConf(null)
    setEnabled(false)
    setHint('已清除定时')
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>定时运行：{rule.name}</h3>
        <p className="muted">到点自动运行规则的当前版本；规则升级后，下一次定时自动采用新版本。</p>
        <div className="row">
          {CRON_PRESETS.map((p) => (
            <button key={p.expr} onClick={() => setCronInput(p.expr)}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="row">
          <input
            style={{ width: 180, fontFamily: 'monospace' }}
            value={cronInput}
            onChange={(e) => setCronInput(e.target.value)}
            placeholder="分 时 日 月 周"
          />
          <select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            <option value="local">本机时区</option>
            <option value="Asia/Shanghai">Asia/Shanghai</option>
            <option value="UTC">UTC</option>
          </select>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            启用
          </label>
        </div>
        {conf && (
          <p className="muted">
            当前已保存：{conf.enabled ? '启用中' : '已停用'} · {conf.cron} · {conf.timezone}
          </p>
        )}
        {hint && <p className="muted">{hint}</p>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={() => void clear()}>清除定时</button>
          <button onClick={onClose}>关闭</button>
          <button className="primary" onClick={() => void save()}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
