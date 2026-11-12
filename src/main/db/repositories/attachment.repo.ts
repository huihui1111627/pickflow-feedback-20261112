import { getDb } from '../connection.js'
import { nowIso, ulid } from '../../services/ids.js'

export interface AttachmentInput {
  resultId: string
  fieldId: string
  url: string
  filename: string
  localPath: string | null
  mime: string | null
  bytes: number | null
  hashSha256: string | null
  status: 'pending' | 'done' | 'failed'
}

interface AttachmentRow {
  id: string
  result_id: string
  field_id: string
  url: string
  local_path: string | null
  filename: string
  mime: string | null
  bytes: number | null
  hash_sha256: string | null
  status: string
  downloaded_at: string | null
}

export const attachmentRepo = {
  // UNIQUE(result_id, url)：重跑同一数据行不会重复登记/下载
  upsert(input: AttachmentInput): string {
    const db = getDb()
    const existing = db
      .prepare('SELECT id, local_path FROM attachments WHERE result_id = ? AND url = ?')
      .get(input.resultId, input.url) as { id: string; local_path: string | null } | undefined

    if (existing) {
      if (existing.local_path) return existing.id
      db.prepare(
        `UPDATE attachments SET local_path = ?, filename = ?, mime = ?, bytes = ?, hash_sha256 = ?, status = ?, downloaded_at = ?
         WHERE id = ?`
      ).run(
        input.localPath,
        input.filename,
        input.mime,
        input.bytes,
        input.hashSha256,
        input.status,
        input.status === 'done' ? nowIso() : null,
        existing.id
      )
      return existing.id
    }

    const id = ulid()
    db.prepare(
      `INSERT INTO attachments (id, result_id, field_id, url, local_path, filename, mime, bytes, hash_sha256, status, downloaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.resultId,
      input.fieldId,
      input.url,
      input.localPath,
      input.filename,
      input.mime,
      input.bytes,
      input.hashSha256,
      input.status,
      input.status === 'done' ? nowIso() : null
    )
    return id
  },

  listByResult(resultId: string): AttachmentRow[] {
    return getDb().prepare('SELECT * FROM attachments WHERE result_id = ?').all(resultId) as AttachmentRow[]
  },

  listByTask(taskId: string): AttachmentRow[] {
    return getDb()
      .prepare(
        `SELECT a.* FROM attachments a
         JOIN results r ON a.result_id = r.id
         WHERE r.task_id = ?`
      )
      .all(taskId) as AttachmentRow[]
  }
}
