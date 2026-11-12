import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from '../db/connection.js'
import { exportsDir } from './paths.js'
import { nowIso, ulid } from './ids.js'

// 导出：结果全量读出写成 CSV / JSON。
// 每条结果都带 _source_url 列，满足来源追溯；附件打包二期再做（attachments 表已就位）。

interface ExportRow {
  data_json: string
  source_url: string
  collected_at: string
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function exportTask(taskId: string, format: 'csv' | 'json'): { exportId: string; path: string } {
  const db = getDb()
  const rows = db
    .prepare('SELECT data_json, source_url, collected_at FROM results WHERE task_id = ? ORDER BY collected_at ASC')
    .all(taskId) as ExportRow[]

  const exportId = ulid()
  const path = join(exportsDir(), `export-${taskId.slice(-6)}-${exportId.slice(-6)}.${format}`)

  if (format === 'json') {
    const data = rows.map((r) => ({
      ...(JSON.parse(r.data_json) as Record<string, unknown>),
      _source_url: r.source_url,
      _collected_at: r.collected_at
    }))
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf8')
  } else {
    // 列 = 全部数据键的并集（按出现顺序），尾部追加来源列
    const keys: string[] = []
    const parsed = rows.map((r) => {
      const data = JSON.parse(r.data_json) as Record<string, unknown>
      for (const k of Object.keys(data)) if (!keys.includes(k)) keys.push(k)
      return data
    })
    const header = [...keys, '_source_url', '_collected_at']
    const lines = [header.map(csvEscape).join(',')]
    parsed.forEach((data, i) => {
      const line = [...keys.map((k) => csvEscape(data[k])), csvEscape(rows[i].source_url), csvEscape(rows[i].collected_at)]
      lines.push(line.join(','))
    })
    // BOM 让 Excel 直接识别 UTF-8 中文
    writeFileSync(path, '﻿' + lines.join('\r\n'), 'utf8')
  }

  db.prepare('INSERT INTO exports (id, task_id, run_id, format, path, status, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)').run(
    exportId,
    taskId,
    format,
    path,
    'done',
    nowIso()
  )
  return { exportId, path }
}
