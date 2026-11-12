import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/ipc.contract'

export default function SettingsView() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    window.api.settings.get().then(setSettings).catch(() => undefined)
  }, [])

  if (!settings) return <p className="muted">加载中…</p>

  const update = (patch: Partial<AppSettings>) => setSettings({ ...settings, ...patch })

  const save = async () => {
    await window.api.settings.set(settings)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>设置</h2>
      <div className="card">
        <h3>采集默认值</h3>
        <div className="row">
          <label>
            行间隔（毫秒）
            <input
              type="number"
              style={{ width: 90, marginLeft: 6 }}
              value={settings.defaultMinIntervalMs}
              onChange={(e) => update({ defaultMinIntervalMs: Number(e.target.value) || 0 })}
            />
          </label>
          <label>
            随机抖动（毫秒）
            <input
              type="number"
              style={{ width: 90, marginLeft: 6 }}
              value={settings.defaultJitterMs}
              onChange={(e) => update({ defaultJitterMs: Number(e.target.value) || 0 })}
            />
          </label>
          <label>
            失败重试次数
            <input
              type="number"
              style={{ width: 70, marginLeft: 6 }}
              value={settings.defaultMaxAttempts}
              onChange={(e) => update({ defaultMaxAttempts: Number(e.target.value) || 1 })}
            />
          </label>
        </div>
        <div className="row">
          <input style={{ width: 360 }} placeholder="附件下载目录（二期用）" value={settings.downloadRoot} readOnly />
          <button
            onClick={() =>
              void window.api.dialog.openDirectory().then((dir) => {
                if (dir) update({ downloadRoot: dir })
              })
            }
          >
            选择目录
          </button>
        </div>
        <button className="primary" onClick={() => void save()}>
          {saved ? '已保存 ✓' : '保存设置'}
        </button>
      </div>
    </div>
  )
}
