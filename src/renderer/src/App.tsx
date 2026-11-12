import { useState } from 'react'
import RulesView from './views/RulesView'
import RuleEditorView from './views/RuleEditorView'
import RunsView from './views/RunsView'
import DataView from './views/DataView'
import SettingsView from './views/SettingsView'

type Tab = 'rules' | 'editor' | 'runs' | 'data' | 'settings'

export default function App() {
  const [tab, setTab] = useState<Tab>('rules')
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null)

  const openEditor = (ruleId: string | null) => {
    setEditingRuleId(ruleId)
    setTab('editor')
  }

  return (
    <div className="app-shell">
      <nav className="sidebar">
        <h1>Pickflow</h1>
        <button className={`tab ${tab === 'rules' ? 'active' : ''}`} onClick={() => setTab('rules')}>
          采集规则
        </button>
        <button className={`tab ${tab === 'editor' ? 'active' : ''}`} onClick={() => setTab('editor')}>
          规则编辑器
        </button>
        <button className={`tab ${tab === 'runs' ? 'active' : ''}`} onClick={() => setTab('runs')}>
          运行任务
        </button>
        <button className={`tab ${tab === 'data' ? 'active' : ''}`} onClick={() => setTab('data')}>
          数据与导出
        </button>
        <button className={`tab ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')}>
          设置
        </button>
      </nav>
      <main className="main">
        {tab === 'rules' && <RulesView onEdit={openEditor} />}
        {tab === 'editor' && <RuleEditorView ruleId={editingRuleId} onSaved={() => setTab('rules')} />}
        {tab === 'runs' && <RunsView />}
        {tab === 'data' && <DataView />}
        {tab === 'settings' && <SettingsView />}
      </main>
    </div>
  )
}
