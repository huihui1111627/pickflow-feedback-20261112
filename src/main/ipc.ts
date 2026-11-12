import { BrowserWindow, dialog, ipcMain } from 'electron'
import type {
  DataQuery,
  PickedElementPayload,
  PreviewRequest,
  StartRunRequest
} from '../shared/ipc.contract.js'
import type { PickerMode, RuleSnapshot } from '../shared/rule.types.js'
import { parseRuleSnapshot } from '../shared/zod/rule.schema.js'
import { playwrightManager } from './browser/PlaywrightManager.js'
import { PickerSession } from './browser/PickerSession.js'
import { ruleRepo } from './db/repositories/rule.repo.js'
import { runRepo } from './db/repositories/run.repo.js'
import { resultRepo } from './db/repositories/result.repo.js'
import { runManager } from './services/runManager.js'
import { previewExtract } from './services/preview.js'
import { exportTask } from './services/export.js'
import { getSettings, setSettings } from './services/settings.js'

// 所有 IPC handler 集中注册，通道名与 shared/ipc.contract.ts 一一对应。

let pickerSession: PickerSession | null = null
let pickerAttachedContext: unknown = null

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

export function registerIpc(): void {
  // ---- 点选会话 ----
  ipcMain.handle('picker:start', async (_e, args: { url?: string }) => {
    const managed = await playwrightManager.start('default')
    if (!pickerSession || pickerAttachedContext !== managed.context) {
      pickerSession = new PickerSession()
      pickerSession.setPickedHandler((payload: PickedElementPayload) => broadcast('picker:picked', payload))
      await pickerSession.attach(managed.context)
      pickerAttachedContext = managed.context
    }
    if (args.url) {
      await managed.page.goto(args.url, { waitUntil: 'domcontentloaded' }).catch(() => undefined)
    }
    return { profileId: managed.profileId }
  })

  ipcMain.handle('picker:stop', async () => {
    await pickerSession?.setMode('off')
  })

  ipcMain.handle('picker:navigate', async (_e, args: { url: string }) => {
    await playwrightManager.navigate(args.url)
  })

  ipcMain.handle('picker:set-mode', async (_e, args: { mode: PickerMode; fieldId?: string }) => {
    if (!pickerSession) throw new Error('点选会话未开始')
    await pickerSession.setMode(args.mode, args.fieldId)
  })

  ipcMain.handle('picker:set-field-meta', async (_e, args: { fieldId: string; name: string; kind: 'text' | 'html' | 'attr'; attr?: string; dataType: 'string' | 'number' | 'boolean' | 'date' }) => {
    if (!pickerSession) throw new Error('点选会话未开始')
    const field = pickerSession.draft.fields.find((f) => f.id === args.fieldId)
    if (!field) throw new Error(`字段不存在: ${args.fieldId}`)
    field.name = args.name
    field.kind = args.kind
    field.attr = args.attr
    field.dataType = args.dataType
  })

  ipcMain.handle('picker:preview', (_e, args: PreviewRequest) => previewExtract(args))

  ipcMain.handle('picker:get-draft', () => {
    const draft = pickerSession?.draft
    return {
      listContainer: draft?.listContainer,
      row: draft?.row,
      fields: draft?.fields ?? [],
      detailLink: draft?.detailLink,
      paginationNext: draft?.paginationNext,
      attachment: draft?.attachment
    }
  })

  // ---- 规则与版本 ----
  ipcMain.handle('rule:list', () => ruleRepo.list())
  ipcMain.handle('rule:get', (_e, args: { ruleId: string }) => ruleRepo.get(args.ruleId))

  ipcMain.handle('rule:create', (_e, args: { name: string; description?: string; snapshot: RuleSnapshot; changeNote?: string }) => {
    const snapshot = parseRuleSnapshot(args.snapshot) as RuleSnapshot
    return ruleRepo.create(args.name, args.description, snapshot, args.changeNote)
  })

  ipcMain.handle('rule:update', (_e, args: { ruleId: string; snapshot: RuleSnapshot; changeNote?: string }) => {
    const snapshot = parseRuleSnapshot(args.snapshot) as RuleSnapshot
    return ruleRepo.update(args.ruleId, snapshot, args.changeNote)
  })

  ipcMain.handle('rule:delete', (_e, args: { ruleId: string }) => ruleRepo.delete(args.ruleId))
  ipcMain.handle('rule:versions', (_e, args: { ruleId: string }) => ruleRepo.versions(args.ruleId))
  ipcMain.handle('rule:get-version', (_e, args: { versionId: string }) => ruleRepo.getVersion(args.versionId))

  // ---- 运行控制 ----
  ipcMain.handle('run:start', (_e, args: StartRunRequest) => runManager.start(args))
  ipcMain.handle('run:stop', (_e, args: { runId: string }) => runManager.stop(args.runId))
  ipcMain.handle('run:resume', (_e, args: { runId: string }) => runManager.resume(args.runId))
  ipcMain.handle('run:continue-login', (_e, args: { runId: string }) => runManager.continueAfterLogin(args.runId))
  ipcMain.handle('run:list', (_e, args: { taskId?: string }) => runRepo.listRuns(args.taskId))
  ipcMain.handle('task:list', () => runRepo.listTasks())

  // ---- 数据与导出 ----
  ipcMain.handle('data:query', (_e, args: DataQuery) => resultRepo.query(args))
  ipcMain.handle('export:start', (_e, args: { taskId: string; format: 'csv' | 'json'; includeAttachments: boolean }) =>
    exportTask(args.taskId, args.format, args.includeAttachments ?? false)
  )

  // ---- 设置与对话框 ----
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, args: Parameters<typeof setSettings>[0]) => setSettings(args))
  ipcMain.handle('dialog:open-directory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
}
