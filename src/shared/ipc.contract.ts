// IPC 通道契约：通道名与请求/响应类型的唯一事实源。
// r->m 走 ipcRenderer.invoke / ipcMain.handle；m->r 走 webContents.send。

import type { ElementDescriptor, FieldCleaning, FieldSpec, LocatorSpec, PickerMode, RuleSnapshot } from './rule.types'
import type { RunEvent, RunStats, RunStatus, RunTrigger } from './run.types'

export interface PickedElementPayload {
  descriptor: ElementDescriptor
  framePath: unknown[]
  candidates: LocatorSpec['candidates']
  unique: boolean
}

export interface PreviewRequest {
  snapshot: Pick<RuleSnapshot, 'list' | 'fields' | 'detail'>
  cleaning?: FieldCleaning[]
}

// 点选草稿的可序列化视图（PickerDraft 里的 Frame 引用过不了 IPC）
export interface PickerDraftDto {
  listContainer?: LocatorSpec
  row?: LocatorSpec
  fields: FieldSpec[]
  detailLink?: LocatorSpec
  paginationNext?: LocatorSpec
}

export interface PreviewRow {
  index: number
  data: Record<string, string | null>
  sourceUrl: string
}

export interface RuleSummary {
  id: string
  name: string
  description: string | null
  currentVersionId: string | null
  versionNo: number | null
  archived: boolean
  createdAt: string
  updatedAt: string
}

export interface RuleVersionRecord {
  id: string
  ruleId: string
  versionNo: number
  snapshot: RuleSnapshot
  checksum: string
  changeNote: string | null
  createdAt: string
}

export interface StartRunRequest {
  ruleVersionId: string
  profileId?: string
  trigger?: RunTrigger
}

export interface RunSummary {
  id: string
  taskId: string
  ruleVersionId: string
  parentRunId: string | null
  trigger: RunTrigger
  status: RunStatus
  stats: RunStats | null
  errorSummary: string | null
  startedAt: string | null
  endedAt: string | null
}

export interface TaskSummary {
  id: string
  ruleId: string
  ruleName: string
  versionNo: number | null
  status: string
  resultCount: number
  createdAt: string
}

export interface DataQuery {
  taskId?: string
  runId?: string
  limit: number
  offset: number
}

export interface DataPage {
  total: number
  rows: {
    id: string
    taskId: string
    runId: string
    ruleVersionId: string
    dedupeKey: string
    data: Record<string, unknown>
    sourceUrl: string
    collectedAt: string
  }[]
}

// 通道名 -> 入参 / 返回值映射，preload 与主进程按此表保持类型一致
export interface IpcContract {
  'app:version': { args: void; result: string }

  'picker:start': { args: { url?: string }; result: { profileId: string } }
  'picker:stop': { args: void; result: void }
  'picker:navigate': { args: { url: string }; result: void }
  'picker:set-mode': { args: { mode: PickerMode; fieldId?: string }; result: void }
  'picker:set-field-meta': {
    args: { fieldId: string; name: string; kind: RuleSnapshot['fields'][number]['kind']; attr?: string; dataType: RuleSnapshot['fields'][number]['dataType'] }
    result: void
  }
  'picker:preview': { args: PreviewRequest; result: { rows: PreviewRow[] } }
  'picker:get-draft': { args: void; result: PickerDraftDto }

  'rule:list': { args: void; result: RuleSummary[] }
  'rule:get': { args: { ruleId: string }; result: RuleSummary | null }
  'rule:create': { args: { name: string; description?: string; snapshot: RuleSnapshot; changeNote?: string }; result: { ruleId: string; versionId: string } }
  'rule:update': { args: { ruleId: string; snapshot: RuleSnapshot; changeNote?: string }; result: { versionId: string } }
  'rule:delete': { args: { ruleId: string }; result: void }
  'rule:versions': { args: { ruleId: string }; result: RuleVersionRecord[] }
  'rule:get-version': { args: { versionId: string }; result: RuleVersionRecord }

  'run:start': { args: StartRunRequest; result: { runId: string; taskId: string } }
  'run:stop': { args: { runId: string }; result: void }
  'run:resume': { args: { runId: string }; result: { runId: string } }
  'run:continue-login': { args: { runId: string }; result: void }
  'run:list': { args: { taskId?: string }; result: RunSummary[] }
  'task:list': { args: void; result: TaskSummary[] }

  'data:query': { args: DataQuery; result: DataPage }

  'export:start': { args: { taskId: string; format: 'csv' | 'json'; includeAttachments: boolean }; result: { exportId: string; path: string } }

  'settings:get': { args: void; result: AppSettings }
  'settings:set': { args: Partial<AppSettings>; result: AppSettings }
  'dialog:open-directory': { args: void; result: string | null }
}

export interface AppSettings {
  downloadRoot: string
  defaultMinIntervalMs: number
  defaultJitterMs: number
  defaultMaxAttempts: number
}

// 主进程推给渲染进程的事件通道
export type PushChannel = 'run:event' | 'picker:picked' | 'picker:hover' | 'login:expired' | 'login:resolved' | 'export:progress'
export type PushPayload = RunEvent | PickedElementPayload
