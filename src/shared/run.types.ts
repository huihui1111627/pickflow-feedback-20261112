// 运行实例的状态机与事件类型。

export type RunStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'paused_login'
  | 'error'
  | 'done'

export type RunTrigger = 'manual' | 'schedule' | 'resume'

export type RunEventLevel = 'debug' | 'info' | 'warn' | 'error'

export interface RunStats {
  pagesProcessed: number
  rowsExtracted: number
  rowsUpserted: number
  rowsFailed: number
  attachmentsDone: number
  attachmentsFailed: number
}

export interface CheckpointCursor {
  phase: 'list' | 'detail'
  page: number
  url: string
  scrolls: number
  rowIndex: number
}

export type RunEvent =
  | { type: 'status'; runId: string; status: RunStatus }
  | { type: 'progress'; runId: string; stats: RunStats; currentUrl: string }
  | { type: 'log'; runId: string; level: RunEventLevel; step: string; message: string; at: string }
  | { type: 'error'; runId: string; step: string; message: string; at: string }
  | { type: 'login-expired'; runId: string; reason: string }
