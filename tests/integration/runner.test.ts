import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { chromium, type BrowserContext } from 'playwright'
import { getDb, closeDb } from '../../src/main/db/connection.js'
import { runRepo } from '../../src/main/db/repositories/run.repo.js'
import { resultRepo } from '../../src/main/db/repositories/result.repo.js'
import { Runner } from '../../src/main/engine/runner.js'
import { ruleRepo } from '../../src/main/db/repositories/rule.repo.js'
import type { RuleSnapshot } from '../../src/shared/rule.types.js'
import type { RunEvent } from '../../src/shared/run.types.js'

// 端到端集成：本地 HTTP 夹具 + 临时 SQLite + headless Chromium，
// 真实跑 Runner 的 提取 → 清洗 → 详情 → 入库 → 续跑幂等 全链路。
// 用 HTTP 而不是 file://，否则详情页相对链接会被解析到文件系统根。

const fixtureRoot = join(import.meta.dirname, '..', 'fixtures')

function startFixtureServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    // /detail/A001 统一返回详情夹具
    const file = url.startsWith('/detail/') ? 'detail.html' : url === '/' ? 'list.html' : url.slice(1)
    try {
      const body = readFileSync(join(fixtureRoot, file))
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(body)
    } catch {
      res.statusCode = 404
      res.end('not found')
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` })
    })
  })
}

const css = (value: string) => ({ candidates: [{ engine: 'css' as const, value }] })

let listUrl: string
let server: Server

function buildSnapshot(): RuleSnapshot {
  return {
    schemaVersion: 1,
    startUrl: listUrl,
    list: {
      container: css('#notice-list'),
      row: css('li.row')
    },
    fields: [
      { id: 'title', name: '标题', kind: 'text', locator: css('.title'), scope: 'list', required: true, dataType: 'string' },
      { id: 'amount', name: '金额', kind: 'text', locator: css('.amount'), scope: 'list', dataType: 'string' },
      { id: 'flag', name: '是否有效', kind: 'text', locator: css('.flag'), scope: 'list', dataType: 'boolean' },
      { id: 'detailCode', name: '详情编号', kind: 'text', locator: css('#detail-code'), scope: 'detail', dataType: 'string' }
    ],
    detail: {
      linkLocator: css('.title'),
      openStrategy: 'new-tab',
      fields: [
        { id: 'detailCode', name: '详情编号', kind: 'text', locator: css('#detail-code'), scope: 'detail', dataType: 'string' }
      ]
    },
    pagination: { mode: 'none', maxPages: 1 },
    cleaning: [
      { fieldId: 'title', ops: [{ op: 'trim' }, { op: 'htmlDecode' }] },
      { fieldId: 'amount', ops: [{ op: 'toType', target: 'number' }] },
      { fieldId: 'flag', ops: [{ op: 'toType', target: 'boolean' }] }
    ],
    attachments: [],
    dedupeKey: ['title'],
    retry: { maxAttempts: 2, backoffBaseMs: 50, backoffMaxMs: 200 },
    throttle: { minIntervalMs: 0, jitterMs: 0 }
  }
}

let context: BrowserContext
const events: RunEvent[] = []

beforeAll(async () => {
  // 每个测试文件独立临时 DB（electron mock 的 app.getPath 已指向临时目录）
  getDb()
  const fixture = await startFixtureServer()
  server = fixture.server
  listUrl = `${fixture.baseUrl}/`
  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'pw-it-')), {
    headless: true,
    acceptDownloads: true
  })
})

afterAll(async () => {
  await context.close()
  server.close()
  closeDb()
})

describe('Runner 端到端', () => {
  it('提取列表+详情、清洗类型转换、入库并保留来源', async () => {
    const snapshot = buildSnapshot()
    const { ruleId, versionId } = ruleRepo.create('集成测试规则', 'it', snapshot, '初始版本')
    const taskId = runRepo.ensureTask(ruleId, versionId, null, { minIntervalMs: 0, jitterMs: 0, maxAttempts: 2 })
    const runId = runRepo.createRun(taskId, versionId, 'manual', null)

    const runner = new Runner({
      runId,
      taskId,
      ruleVersionId: versionId,
      snapshot,
      context,
      resumeCursor: null,
      emit: (e) => events.push(e)
    })
    await runner.run()

    expect(runRepo.getRun(runId).status).toBe('done')

    const page = resultRepo.query({ taskId, limit: 50, offset: 0 })
    expect(page.total).toBe(3)

    const first = page.rows.find((r) => String(r.data.title).includes('机房扩容'))!
    expect(first).toBeTruthy()
    // trim 生效
    expect(first.data.title).toBe('机房扩容采购公告')
    // 货币字符串转数字
    expect(first.data.amount).toBe(1200)
    // 中文布尔
    expect(first.data.flag).toBe(true)
    // 详情页字段
    expect(first.data.detailCode).toBe('CODE-X')
    // 来源可追溯到详情 URL
    expect(first.sourceUrl).toContain('/detail/A001')
    expect(first.ruleVersionId).toBe(versionId)

    // 第二行：htmlDecode + 百分比转小数
    const second = page.rows.find((r) => String(r.data.title).includes('网络设备'))!
    expect(second.data.title).toBe('网络设备升级 & 运维')
    expect(second.data.amount).toBe(0.45)
    expect(second.data.flag).toBe(false)

    // 第三行英文布尔
    const third = page.rows.find((r) => String(r.data.title).includes('安防'))!
    expect(third.data.flag).toBe(true)
  })

  it('同 task 重跑不重复入库（跨 run 幂等）', async () => {
    const snapshot = buildSnapshot()
    const { ruleId, versionId } = ruleRepo.create('幂等规则', 'it', snapshot, 'v1')
    const taskId = runRepo.ensureTask(ruleId, versionId, null, { minIntervalMs: 0, jitterMs: 0, maxAttempts: 2 })

    for (let i = 0; i < 2; i++) {
      const runId = runRepo.createRun(taskId, versionId, 'manual', null)
      const runner = new Runner({
        runId,
        taskId,
        ruleVersionId: versionId,
        snapshot,
        context,
        resumeCursor: null,
        emit: () => undefined
      })
      await runner.run()
      expect(runRepo.getRun(runId).status).toBe('done')
    }

    const page = resultRepo.query({ taskId, limit: 50, offset: 0 })
    expect(page.total).toBe(3)
    // 两次 run 都存在，但结果只有 3 行
    expect(runRepo.listRuns(taskId)).toHaveLength(2)
  })

  it('停止后带检查点续跑，最终数据完整且不重复', async () => {
    const snapshot = buildSnapshot()
    const { ruleId, versionId } = ruleRepo.create('续跑规则', 'it', snapshot, 'v1')
    const taskId = runRepo.ensureTask(ruleId, versionId, null, { minIntervalMs: 0, jitterMs: 0, maxAttempts: 2 })

    // 第一次 run：处理完第一行后请求停止
    const run1 = runRepo.createRun(taskId, versionId, 'manual', null)
    const runner1 = new Runner({
      runId: run1,
      taskId,
      ruleVersionId: versionId,
      snapshot,
      context,
      resumeCursor: null,
      emit: (e) => {
        if (e.type === 'progress' && e.stats.rowsUpserted >= 1) runner1.requestStop()
      }
    })
    await runner1.run()
    expect(runRepo.getRun(run1).status).toBe('stopped')
    expect(runRepo.getCheckpoint(run1)).not.toBeNull()

    // 续跑：新 run 挂 parent，从检查点快进
    const cursor = runRepo.getCheckpoint(run1)
    const run2 = runRepo.createRun(taskId, versionId, 'resume', run1)
    const runner2 = new Runner({
      runId: run2,
      taskId,
      ruleVersionId: versionId,
      snapshot,
      context,
      resumeCursor: cursor,
      emit: () => undefined
    })
    await runner2.run()
    expect(runRepo.getRun(run2).status).toBe('done')

    const page = resultRepo.query({ taskId, limit: 50, offset: 0 })
    expect(page.total).toBe(3)
    expect(page.rows.map((r) => r.data.title).sort()).toEqual(
      ['机房扩容采购公告', '安防系统维保', '网络设备升级 & 运维'].sort()
    )
  })
})
