// vitest 里的 electron 替身：只提供主进程代码用到的最小表面。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'pickflow-test-'))

export const app = {
  getPath: (_name: string): string => userData,
  getVersion: (): string => '0.0.0-test',
  isPackaged: false
}

export const ipcMain = { handle: () => undefined }
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
export const shell = { openExternal: async () => undefined }
export const BrowserWindow = class {}
