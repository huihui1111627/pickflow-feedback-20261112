import { createWriteStream, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import archiver from 'archiver'
import { getDb } from '../db/connection.js'
import { exportsDir } from './paths.js'
import { nowIso, ulid } from './ids.js'
import { attachmentRepo } from '../db/repositories/attachment.repo.js'

// 导出：结果写成 CSV / JSON；includeAttachments 时打 zip，
// 内含数据文件、files/ 附件目录（按内容寻址去重）和 manifest.json 清单。

interface ExportRow {
  id: string
  data_json: string
  source_url: string
  collected_at: string
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function loadRows(taskId: string): ExportRow[] {
  return getDb()
    .prepare('SELECT id, data_json, source_url, collected_at FROM results WHERE task_id = ? ORDER BY collected_at ASC')
    .all(taskId) as ExportRow[]
}

function buildJson(rows: ExportRow[]) {
  return rows.map((r) => ({
    _result_id: r.id,
    ...(JSON.parse(r.data_json) as Record<string, unknown>),
    _source_url: r.source_url,
    _collected_at: r.collected_at
  }))
}

function buildCsv(rows: ExportRow[]): string {
  const keys: string[] = []
  const parsed = rows.map((r) => {
    const data = JSON.parse(r.data_json) as Record<string, unknown>
    for (const k of Object.keys(data)) if (!keys.includes(k)) keys.push(k)
    return data
  })
  const header = ['_result_id', ...keys, '_source_url', '_collected_at']
  const lines = [header.map(csvEscape).join(',')]
  parsed.forEach((data, i) => {
    const line = [
      csvEscape(rows[i].id),
      ...keys.map((k) => csvEscape(data[k])),
      csvEscape(rows[i].source_url),
      csvEscape(rows[i].collected_at)
    ]
    lines.push(line.join(','))
  })
  // BOM 让 Excel 直接识别 UTF-8 中文
  return '﻿' + lines.join('\r\n')
}

// 数据文件里附件字段如何指向包内文件：manifest 负责 resultId -> files 路径 的映射
function buildManifest(taskId: string, rows: ExportRow[]) {
  const attachments = attachmentRepo.listByTask(taskId)
  const byResult = new Map<string, typeof attachments>()
  for (const att of attachments) {
    const list = byResult.get(att.result_id) ?? []
    list.push(att)
    byResult.set(att.result_id, list)
  }
  return rows.map((r) => ({
    resultId: r.id,
    sourceUrl: r.source_url,
    attachments: (byResult.get(r.id) ?? [])
      .filter((a) => a.status === 'done' && a.local_path)
      .map((a) => ({
        fieldId: a.field_id,
        url: a.url,
        filename: a.filename,
        packagePath: `files/${basename(a.local_path!)}`,
        mime: a.mime,
        bytes: a.bytes,
        sha256: a.hash_sha256
      }))
  }))
}

export interface ExportResult {
  exportId: string
  path: string
}

export async function exportTask(
  taskId: string,
  format: 'csv' | 'json',
  includeAttachments: boolean
): Promise<ExportResult> {
  const db = getDb()
  const rows = loadRows(taskId)
  const exportId = ulid()
  const dir = exportsDir()

  const dataPayload = format === 'json' ? JSON.stringify(buildJson(rows), null, 2) : buildCsv(rows)
  const dataName = `data.${format}`

  // 没有附件或不要求带附件：维持单文件导出
  const attachments = includeAttachments ? attachmentRepo.listByTask(taskId).filter((a) => a.status === 'done' && a.local_path) : []
  if (attachments.length === 0) {
    const path = join(dir, `export-${taskId.slice(-6)}-${exportId.slice(-6)}.${format}`)
    writeFileSync(path, dataPayload, 'utf8')
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

  // 带附件：zip = 数据文件 + files/（物理文件去重）+ manifest.json
  const zipPath = join(dir, `export-${taskId.slice(-6)}-${exportId.slice(-6)}.zip`)
  const manifest = buildManifest(taskId, rows)

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(zipPath)
    const archive = archiver('zip', { zlib: { level: 9 } })
    output.on('close', () => resolve())
    archive.on('error', (err) => reject(err))
    archive.pipe(output)

    archive.append(dataPayload, { name: dataName })
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' })

    // 内容寻址文件名本身即 hash，天然去重；用 Set 避免重复 append 同名条目
    const seen = new Set<string>()
    for (const att of attachments) {
      const stored = basename(att.local_path!)
      if (seen.has(stored)) continue
      if (!existsSync(att.local_path!)) continue
      seen.add(stored)
      archive.file(att.local_path!, { name: `files/${stored}` })
    }
    void archive.finalize()
  })

  db.prepare('INSERT INTO exports (id, task_id, run_id, format, path, status, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)').run(
    exportId,
    taskId,
    `${format}+zip`,
    zipPath,
    'done',
    nowIso()
  )
  return { exportId, path: zipPath }
}
