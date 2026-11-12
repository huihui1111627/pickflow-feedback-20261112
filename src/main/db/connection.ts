import Database from 'better-sqlite3'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dbPath } from '../services/paths.js'

// better-sqlite3 同步 API，只允许在主进程使用。
let dbInstance: Database.Database | null = null

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance

  const db = new Database(dbPath())
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')

  migrate(db)
  dbInstance = db
  return db
}

export function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  db.pragma('foreign_keys = OFF')
  try {
    for (const file of files) {
      const version = Number(file.split('_')[0])
      if (Number.isNaN(version) || version <= current) continue
      const sql = readFileSync(join(migrationsDir, file), 'utf8')
      db.exec('BEGIN')
      try {
        db.exec(sql)
        db.exec(`PRAGMA user_version = ${version}`)
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    }
  } finally {
    db.pragma('foreign_keys = ON')
  }
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close()
    dbInstance = null
  }
}
