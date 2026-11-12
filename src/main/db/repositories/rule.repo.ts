import { getDb } from '../connection.js'
import { nowIso, sha256, ulid } from '../../services/ids.js'
import type { RuleSnapshot } from '../../../shared/rule.types.js'
import type { RuleSummary, RuleVersionRecord } from '../../../shared/ipc.contract.js'

interface RuleRow {
  id: string
  name: string
  description: string | null
  current_version_id: string | null
  archived: number
  created_at: string
  updated_at: string
}

interface VersionRow {
  id: string
  rule_id: string
  version_no: number
  content_json: string
  checksum: string
  change_note: string | null
  created_at: string
}

function toSummary(row: RuleRow, versionNo: number | null): RuleSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    currentVersionId: row.current_version_id,
    versionNo,
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toVersionRecord(row: VersionRow): RuleVersionRecord {
  return {
    id: row.id,
    ruleId: row.rule_id,
    versionNo: row.version_no,
    snapshot: JSON.parse(row.content_json) as RuleSnapshot,
    checksum: row.checksum,
    changeNote: row.change_note,
    createdAt: row.created_at
  }
}

export const ruleRepo = {
  list(): RuleSummary[] {
    const db = getDb()
    const rows = db
      .prepare(
        `SELECT r.*, rv.version_no
         FROM rules r
         LEFT JOIN rule_versions rv ON r.current_version_id = rv.id
         WHERE r.archived = 0
         ORDER BY r.updated_at DESC`
      )
      .all() as (RuleRow & { version_no: number | null })[]
    return rows.map((r) => toSummary(r, r.version_no))
  },

  get(ruleId: string): RuleSummary | null {
    const db = getDb()
    const row = db
      .prepare(
        `SELECT r.*, rv.version_no
         FROM rules r
         LEFT JOIN rule_versions rv ON r.current_version_id = rv.id
         WHERE r.id = ?`
      )
      .get(ruleId) as (RuleRow & { version_no: number | null }) | undefined
    return row ? toSummary(row, row.version_no) : null
  },

  create(name: string, description: string | undefined, snapshot: RuleSnapshot, changeNote?: string): { ruleId: string; versionId: string } {
    const db = getDb()
    const ruleId = ulid()
    const versionId = ulid()
    const ts = nowIso()
    const content = JSON.stringify(snapshot)
    const checksum = sha256(content)

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO rules (id, name, description, current_version_id, archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`
      ).run(ruleId, name, description ?? null, versionId, ts, ts)

      db.prepare(
        `INSERT INTO rule_versions (id, rule_id, version_no, content_json, checksum, change_note, created_at)
         VALUES (?, ?, 1, ?, ?, ?, ?)`
      ).run(versionId, ruleId, content, checksum, changeNote ?? null, ts)
    })
    tx()
    return { ruleId, versionId }
  },

  // 更新总是写入不可变新版本，绝不原地覆盖旧快照
  update(ruleId: string, snapshot: RuleSnapshot, changeNote?: string): { versionId: string } {
    const db = getDb()
    const ts = nowIso()
    const versionId = ulid()
    const content = JSON.stringify(snapshot)
    const checksum = sha256(content)

    const tx = db.transaction(() => {
      const last = db
        .prepare('SELECT MAX(version_no) AS v FROM rule_versions WHERE rule_id = ?')
        .get(ruleId) as { v: number | null }
      const nextNo = (last.v ?? 0) + 1

      db.prepare(
        `INSERT INTO rule_versions (id, rule_id, version_no, content_json, checksum, change_note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(versionId, ruleId, nextNo, content, checksum, changeNote ?? null, ts)

      db.prepare('UPDATE rules SET current_version_id = ?, updated_at = ? WHERE id = ?').run(versionId, ts, ruleId)
    })
    tx()
    return { versionId }
  },

  delete(ruleId: string): void {
    const db = getDb()
    // 软删除，保留历史 run 的外键完整性
    db.prepare('UPDATE rules SET archived = 1, updated_at = ? WHERE id = ?').run(nowIso(), ruleId)
  },

  versions(ruleId: string): RuleVersionRecord[] {
    const db = getDb()
    const rows = db
      .prepare('SELECT * FROM rule_versions WHERE rule_id = ? ORDER BY version_no DESC')
      .all(ruleId) as VersionRow[]
    return rows.map(toVersionRecord)
  },

  getVersion(versionId: string): RuleVersionRecord {
    const db = getDb()
    const row = db.prepare('SELECT * FROM rule_versions WHERE id = ?').get(versionId) as VersionRow | undefined
    if (!row) throw new Error(`规则版本不存在: ${versionId}`)
    return toVersionRecord(row)
  }
}
