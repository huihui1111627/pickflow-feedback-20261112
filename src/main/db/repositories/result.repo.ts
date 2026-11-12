import { getDb } from '../connection.js'
import { nowIso, sha256, ulid } from '../../services/ids.js'
import type { DataPage, DataQuery } from '../../../shared/ipc.contract.js'

export interface ResultInput {
  taskId: string
  runId: string
  ruleVersionId: string
  /** 已清洗的字段键值 */
  data: Record<string, unknown>
  /** 去重键字段的规范拼接值（可读） */
  dedupeKey: string
  sourceUrl: string
  collectedAt: string
}

interface ResultRow {
  id: string
  task_id: string
  run_id: string
  rule_version_id: string
  row_hash: string
  dedupe_key: string
  data_json: string
  source_url: string
  collected_at: string
  created_at: string
}

// 对去重键值做规范化 hash：键排序、字符串 trim，保证同数据不同采集批次得到相同 hash
export function computeRowHash(dedupeKey: string, data: Record<string, unknown>, dedupeFields: string[]): string {
  if (dedupeFields.length > 0) {
    const normalized = dedupeFields
      .map((f) => [f, normalizeValue(data[f])])
      .sort(([a], [b]) => a.localeCompare(b))
    return sha256(JSON.stringify(normalized))
  }
  // 未配去重键：全字段 hash
  const full = Object.keys(data)
    .sort()
    .map((k) => [k, normalizeValue(data[k])])
  return sha256(JSON.stringify(full) + '|' + dedupeKey)
}

function normalizeValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  return JSON.stringify(value)
}

export const resultRepo = {
  // 固定 upsert：同 task 同 row_hash 永远只有一行，跨 run 幂等的最终保证
  upsert(input: ResultInput, dedupeFields: string[]): { id: string; inserted: boolean } {
    const db = getDb()
    const rowHash = computeRowHash(input.dedupeKey, input.data, dedupeFields)
    const existing = db
      .prepare('SELECT id FROM results WHERE task_id = ? AND row_hash = ?')
      .get(input.taskId, rowHash) as { id: string } | undefined

    if (existing) {
      db.prepare(
        `UPDATE results SET run_id = ?, data_json = ?, source_url = ?, collected_at = ? WHERE id = ?`
      ).run(input.runId, JSON.stringify(input.data), input.sourceUrl, input.collectedAt, existing.id)
      return { id: existing.id, inserted: false }
    }

    const id = ulid()
    db.prepare(
      `INSERT INTO results (id, task_id, run_id, rule_version_id, row_hash, dedupe_key, data_json, source_url, collected_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.taskId,
      input.runId,
      input.ruleVersionId,
      rowHash,
      input.dedupeKey,
      JSON.stringify(input.data),
      input.sourceUrl,
      input.collectedAt,
      nowIso()
    )
    return { id, inserted: true }
  },

  query(q: DataQuery): DataPage {
    const db = getDb()
    const where: string[] = []
    const params: unknown[] = []
    if (q.taskId) {
      where.push('task_id = ?')
      params.push(q.taskId)
    }
    if (q.runId) {
      where.push('run_id = ?')
      params.push(q.runId)
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

    const total = (db.prepare(`SELECT COUNT(*) AS c FROM results ${whereSql}`).get(...params) as { c: number }).c
    const rows = db
      .prepare(`SELECT * FROM results ${whereSql} ORDER BY collected_at DESC LIMIT ? OFFSET ?`)
      .all(...params, q.limit, q.offset) as ResultRow[]

    return {
      total,
      rows: rows.map((r) => ({
        id: r.id,
        taskId: r.task_id,
        runId: r.run_id,
        ruleVersionId: r.rule_version_id,
        dedupeKey: r.dedupe_key,
        data: JSON.parse(r.data_json) as Record<string, unknown>,
        sourceUrl: r.source_url,
        collectedAt: r.collected_at
      }))
    }
  },

  countByTask(taskId: string): number {
    return (getDb().prepare('SELECT COUNT(*) AS c FROM results WHERE task_id = ?').get(taskId) as { c: number }).c
  }
}
