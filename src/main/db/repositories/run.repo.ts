import { getDb } from '../connection.js'
import { nowIso, ulid } from '../../services/ids.js'
import type { CheckpointCursor, RunStats, RunStatus, RunTrigger } from '../../../shared/run.types.js'
import type { RunSummary, TaskSummary } from '../../../shared/ipc.contract.js'

interface TaskRow {
  id: string
  rule_id: string
  rule_version_id: string
  profile_id: string | null
  settings_json: string
  schedule_json: string | null
  status: string
  created_at: string
}

function safeParseSchedule(raw: string | null): { cron: string; timezone: string; enabled: boolean } | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { cron?: string; timezone?: string; enabled?: boolean }
    if (!parsed.cron || typeof parsed.enabled !== 'boolean') return null
    return { cron: parsed.cron, timezone: parsed.timezone || 'local', enabled: parsed.enabled }
  } catch {
    return null
  }
}

interface RunRow {
  id: string
  task_id: string
  rule_version_id: string
  parent_run_id: string | null
  trigger: RunTrigger
  status: RunStatus
  stats_json: string | null
  error_summary: string | null
  started_at: string | null
  ended_at: string | null
}

function toRunSummary(row: RunRow): RunSummary {
  return {
    id: row.id,
    taskId: row.task_id,
    ruleVersionId: row.rule_version_id,
    parentRunId: row.parent_run_id,
    trigger: row.trigger,
    status: row.status,
    stats: row.stats_json ? (JSON.parse(row.stats_json) as RunStats) : null,
    errorSummary: row.error_summary,
    startedAt: row.started_at,
    endedAt: row.ended_at
  }
}

export interface TaskSettings {
  minIntervalMs: number
  jitterMs: number
  maxAttempts: number
  downloadDir?: string
}

export const runRepo = {
  // 首次以某规则运行时创建长期任务实体；同一规则版本重复运行复用同一 task（去重边界）
  ensureTask(ruleId: string, ruleVersionId: string, profileId: string | null, settings: TaskSettings): string {
    const db = getDb()
    const existing = db
      .prepare('SELECT id FROM tasks WHERE rule_id = ? AND rule_version_id = ? LIMIT 1')
      .get(ruleId, ruleVersionId) as { id: string } | undefined
    if (existing) return existing.id

    const taskId = ulid()
    db.prepare(
      `INSERT INTO tasks (id, rule_id, rule_version_id, profile_id, settings_json, schedule_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, 'idle', ?)`
    ).run(taskId, ruleId, ruleVersionId, profileId, JSON.stringify(settings), nowIso())
    return taskId
  },

  getTask(taskId: string): TaskRow {
    const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined
    if (!row) throw new Error(`任务不存在: ${taskId}`)
    return row
  },

  // 定时配置入口用：取规则当前版本对应的任务，没有则返回 null（由上层先跑一次或自动建）
  findTaskByRule(ruleId: string): TaskRow | null {
    const row = getDb()
      .prepare('SELECT * FROM tasks WHERE rule_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(ruleId) as TaskRow | undefined
    return row ?? null
  },

  // 供调度器拿到规则当前版本号，自动建任务时使用
  ensureTaskForRule(ruleId: string, ruleVersionId: string, profileId: string | null, settings: TaskSettings): string {
    return this.ensureTask(ruleId, ruleVersionId, profileId, settings)
  },

  setTaskSchedule(taskId: string, schedule: { cron: string; timezone: string; enabled: boolean } | null): void {
    getDb().prepare('UPDATE tasks SET schedule_json = ? WHERE id = ?').run(schedule ? JSON.stringify(schedule) : null, taskId)
  },

  // 调度器每次 tick 调用：只返回启用了定时且表达式存在的任务
  listScheduledTasks(): (TaskRow & { schedule: { cron: string; timezone: string; enabled: boolean } })[] {
    const rows = getDb().prepare('SELECT * FROM tasks WHERE schedule_json IS NOT NULL').all() as TaskRow[]
    return rows
      .map((row) => ({ row, schedule: safeParseSchedule(row.schedule_json) }))
      .filter((x): x is { row: TaskRow; schedule: { cron: string; timezone: string; enabled: boolean } } => !!x.schedule && x.schedule.enabled)
      .map(({ row, schedule }) => ({ ...row, schedule }))
  },

  setTaskStatus(taskId: string, status: RunStatus): void {
    getDb().prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, taskId)
  },

  createRun(taskId: string, ruleVersionId: string, trigger: RunTrigger, parentRunId: string | null): string {
    const db = getDb()
    const runId = ulid()
    db.prepare(
      `INSERT INTO task_runs (id, task_id, rule_version_id, parent_run_id, trigger, status, started_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?)`
    ).run(runId, taskId, ruleVersionId, parentRunId, trigger, nowIso())
    return runId
  },

  updateStatus(runId: string, status: RunStatus, errorSummary?: string): void {
    const db = getDb()
    if (status === 'done' || status === 'stopped' || status === 'error') {
      db.prepare('UPDATE task_runs SET status = ?, error_summary = COALESCE(?, error_summary), ended_at = ? WHERE id = ?').run(
        status,
        errorSummary ?? null,
        nowIso(),
        runId
      )
    } else {
      db.prepare('UPDATE task_runs SET status = ? WHERE id = ?').run(status, runId)
    }
  },

  updateStats(runId: string, stats: RunStats): void {
    getDb().prepare('UPDATE task_runs SET stats_json = ? WHERE id = ?').run(JSON.stringify(stats), runId)
  },

  getRun(runId: string): RunSummary {
    const row = getDb().prepare('SELECT * FROM task_runs WHERE id = ?').get(runId) as RunRow | undefined
    if (!row) throw new Error(`运行实例不存在: ${runId}`)
    return toRunSummary(row)
  },

  listRuns(taskId?: string): RunSummary[] {
    const db = getDb()
    const rows = taskId
      ? (db.prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC').all(taskId) as RunRow[])
      : (db.prepare('SELECT * FROM task_runs ORDER BY started_at DESC LIMIT 200').all() as RunRow[])
    return rows.map(toRunSummary)
  },

  listTasks(): TaskSummary[] {
    const db = getDb()
    const rows = db
      .prepare(
        `SELECT t.id, t.rule_id, t.status, t.created_at,
                r.name AS rule_name, rv.version_no,
                (SELECT COUNT(*) FROM results res WHERE res.task_id = t.id) AS result_count
         FROM tasks t
         JOIN rules r ON r.id = t.rule_id
         LEFT JOIN rule_versions rv ON rv.id = t.rule_version_id
         ORDER BY t.created_at DESC`
      )
      .all() as { id: string; rule_id: string; status: string; created_at: string; rule_name: string; version_no: number | null; result_count: number }[]
    return rows.map((r) => ({
      id: r.id,
      ruleId: r.rule_id,
      ruleName: r.rule_name,
      versionNo: r.version_no,
      status: r.status,
      resultCount: r.result_count,
      createdAt: r.created_at
    }))
  },

  // ---- checkpoint ----
  saveCheckpoint(runId: string, cursor: CheckpointCursor): void {
    const db = getDb()
    db.prepare(
      `INSERT INTO run_checkpoints (run_id, phase, cursor_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET phase = excluded.phase, cursor_json = excluded.cursor_json, updated_at = excluded.updated_at`
    ).run(runId, cursor.phase, JSON.stringify(cursor), nowIso())
  },

  getCheckpoint(runId: string): CheckpointCursor | null {
    const row = getDb().prepare('SELECT cursor_json FROM run_checkpoints WHERE run_id = ?').get(runId) as
      | { cursor_json: string }
      | undefined
    return row ? (JSON.parse(row.cursor_json) as CheckpointCursor) : null
  },

  // ---- run_items：单 run 步骤幂等 ----
  isItemDone(runId: string, itemKey: string): boolean {
    const row = getDb()
      .prepare('SELECT status FROM run_items WHERE run_id = ? AND item_key = ?')
      .get(runId, itemKey) as { status: string } | undefined
    return row?.status === 'done'
  },

  markItem(runId: string, itemKey: string, kind: 'list_page' | 'detail_page', status: 'done' | 'failed', error?: string): void {
    const db = getDb()
    db.prepare(
      `INSERT INTO run_items (run_id, item_key, kind, status, attempts, last_error, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(run_id, item_key) DO UPDATE SET
         status = excluded.status,
         attempts = run_items.attempts + 1,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`
    ).run(runId, itemKey, kind, status, error ?? null, nowIso())
  },

  appendLog(runId: string, level: string, step: string, message: string): void {
    getDb()
      .prepare('INSERT INTO run_logs (id, run_id, level, step, message, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ulid(), runId, level, step, message, nowIso())
  }
}
