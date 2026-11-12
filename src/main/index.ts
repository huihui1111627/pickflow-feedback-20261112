import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { createMainWindow } from './window.js'
import { registerIpc } from './ipc.js'
import { closeDb, getDb } from './db/connection.js'
import { playwrightManager } from './browser/PlaywrightManager.js'
import { scheduler } from './services/scheduler.js'

// 单实例锁，避免多个主进程同时写同一个 SQLite / Playwright profile
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const wins = BrowserWindow.getAllWindows()
    if (wins.length > 0) {
      const win = wins[0]
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    getDb() // 启动即完成迁移，避免首次操作时卡顿
    registerIpc()
    ipcMain.handle('app:version', () => app.getVersion())
    scheduler.start() // 定时任务扫描，应用重启后自动恢复

    const mainWindow = createMainWindow()

    // 外链交给系统浏览器，不在应用内开导航
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url)
      return { action: 'deny' }
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    scheduler.stop()
    void playwrightManager.stop().finally(() => {
      closeDb()
      app.quit()
    })
  })
}
