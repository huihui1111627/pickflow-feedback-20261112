import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

// userData 下的目录约定，集中管理避免路径散落各处。
let rootCache: string | null = null

function root(): string {
  if (!rootCache) {
    rootCache = app.getPath('userData')
  }
  return rootCache
}

export function dbPath(): string {
  return join(root(), 'pickflow.db')
}

export function profilesDir(): string {
  const dir = join(root(), 'profiles')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function profileDir(profileId: string): string {
  const dir = join(profilesDir(), profileId)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function attachmentsRoot(): string {
  const dir = join(root(), 'attachments')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function taskAttachmentsDir(taskId: string): string {
  const dir = join(attachmentsRoot(), taskId)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function exportsDir(): string {
  const dir = join(root(), 'exports')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function settingsPath(): string {
  return join(root(), 'settings.json')
}
