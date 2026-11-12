import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { settingsPath } from './paths.js'
import type { AppSettings } from '../../shared/ipc.contract.js'

const DEFAULTS: AppSettings = {
  downloadRoot: '',
  defaultMinIntervalMs: 800,
  defaultJitterMs: 400,
  defaultMaxAttempts: 3
}

let cache: AppSettings | null = null

export function getSettings(): AppSettings {
  if (cache) return cache
  try {
    if (existsSync(settingsPath())) {
      cache = { ...DEFAULTS, ...(JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<AppSettings>) }
      return cache
    }
  } catch {
    // 配置文件损坏时回退默认值
  }
  cache = { ...DEFAULTS }
  return cache
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  cache = { ...getSettings(), ...patch }
  writeFileSync(settingsPath(), JSON.stringify(cache, null, 2), 'utf8')
  return cache
}
