import { contextBridge, ipcRenderer } from 'electron'
import type { IpcContract, PickedElementPayload } from '../shared/ipc.contract.js'
import type { RunEvent } from '../shared/run.types.js'

// 白名单 API：渲染进程只允许通过这些方法与主进程通信，拿不到 ipcRenderer 原始对象

type Channel = keyof IpcContract

function invoke<C extends Channel>(channel: C, args: IpcContract[C]['args']): Promise<IpcContract[C]['result']> {
  return ipcRenderer.invoke(channel, args) as Promise<IpcContract[C]['result']>
}

const api = {
  app: {
    version: (): Promise<string> => ipcRenderer.invoke('app:version')
  },
  picker: {
    start: (url?: string) => invoke('picker:start', url ? { url } : {}),
    stop: () => invoke('picker:stop', undefined as void),
    navigate: (url: string) => invoke('picker:navigate', { url }),
    setMode: (mode: string, fieldId?: string) => invoke('picker:set-mode', { mode, fieldId } as IpcContract['picker:set-mode']['args']),
    setFieldMeta: (args: IpcContract['picker:set-field-meta']['args']) => invoke('picker:set-field-meta', args),
    preview: (args: IpcContract['picker:preview']['args']) => invoke('picker:preview', args),
    getDraft: () => invoke('picker:get-draft', undefined as void),
    onPicked: (handler: (payload: PickedElementPayload) => void): (() => void) => {
      const listener = (_e: unknown, payload: PickedElementPayload): void => handler(payload)
      ipcRenderer.on('picker:picked', listener)
      return () => ipcRenderer.removeListener('picker:picked', listener)
    }
  },
  rule: {
    list: () => invoke('rule:list', undefined as void),
    get: (ruleId: string) => invoke('rule:get', { ruleId }),
    create: (args: IpcContract['rule:create']['args']) => invoke('rule:create', args),
    update: (args: IpcContract['rule:update']['args']) => invoke('rule:update', args),
    delete: (ruleId: string) => invoke('rule:delete', { ruleId }),
    versions: (ruleId: string) => invoke('rule:versions', { ruleId }),
    getVersion: (versionId: string) => invoke('rule:get-version', { versionId })
  },
  run: {
    start: (args: IpcContract['run:start']['args']) => invoke('run:start', args),
    stop: (runId: string) => invoke('run:stop', { runId }),
    resume: (runId: string) => invoke('run:resume', { runId }),
    continueLogin: (runId: string) => invoke('run:continue-login', { runId }),
    list: (taskId?: string) => invoke('run:list', taskId ? { taskId } : {}),
    listTasks: () => invoke('task:list', undefined as void),
    onEvent: (handler: (event: RunEvent) => void): (() => void) => {
      const listener = (_e: unknown, event: RunEvent): void => handler(event)
      ipcRenderer.on('run:event', listener)
      return () => ipcRenderer.removeListener('run:event', listener)
    }
  },
  data: {
    query: (args: IpcContract['data:query']['args']) => invoke('data:query', args)
  },
  exporter: {
    start: (taskId: string, format: 'csv' | 'json') => invoke('export:start', { taskId, format, includeAttachments: false })
  },
  settings: {
    get: () => invoke('settings:get', undefined as void),
    set: (patch: Partial<IpcContract['settings:get']['result']>) => invoke('settings:set', patch)
  },
  dialog: {
    openDirectory: () => invoke('dialog:open-directory', undefined as void)
  }
}

export type PreloadApi = typeof api

contextBridge.exposeInMainWorld('api', api)
