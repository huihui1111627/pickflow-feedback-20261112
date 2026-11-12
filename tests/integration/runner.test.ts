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
import { attachmentRepo } from '../../src/main/db/repositories/attachment.repo.js'
import { exportTask } from '../../src/main/services/export.js'
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import type { RuleSnapshot } from '../../src/shared/rule.types.js'
import type { RunEvent } from '../../src/shared/run.types.js'

// 端到端集成：本地 HTTP 夹具 + 临时 SQLite + headless Chromium，
// 真实跑 Runner 的 提取 → 清洗 → 详情 → 入库 → 续跑幂等 全链路。
// 用 HTTP 而不是 file://，否则详情页相对链接会被解析到文件系统根。

const fixtureRoot = join(import.meta.dirname, '..', 'fixtures')

function startFixtureServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    // /detail/A001 返回详情夹具；/files/* 映射到夹具根目录的同名文件
    let file: string
    if (url.startsWith('/detail/')) file = 'detail.html'
    else if (url.startsWith('/files/')) file = url.slice('/files/'.length)
    else file = url === '/' ? 'list.html' : url.slice(1)
    try {
      const body = readFileSync(join(fixtureRoot, file))
      const mime = file.endsWith('.pdf') ? 'application/pdf' : 'text/html; charset=utf-8'
      res.setHeader('content-type', mime)
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
      { id: 'fileUrl', name: '附件直链', kind: 'attr', attr: 'href', locator: css('.list-file'), scope: 'list', dataType: 'string' },
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
    attachments: [
      {
        id: 'specDoc',
        locator: css('.doc-link'),
        attr: 'href',
        allowedExtensions: ['pdf'],
        naming: '{rowIndex}-{filename}'
      }
    ],
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

    // 附件：每行详情页一个 pdf，共 3 个，落盘且内容可寻址
    const attachments = attachmentRepo.listByTask(taskId)
    expect(attachments).toHaveLength(3)
    for (const att of attachments) {
      expect(att.status).toBe('done')
      expect(att.mime).toBe('application/pdf')
      expect(att.local_path).toBeTruthy()
      expect(existsSync(att.local_path!)).toBe(true)
      // 同一内容 hash 相同，三个文件指向同一份内容寻址文件
      const disk = readFileSync(att.local_path!)
      expect(disk.toString()).toContain('PDF-BINARY-CONTENT')
      expect(att.hash_sha256).toBeTruthy()
    }
    // 内容寻址：相同内容只存一份物理文件
    const uniquePaths = new Set(attachments.map((a) => a.local_path))
    expect(uniquePaths.size).toBe(1)
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
    // 附件登记同样不重复
    expect(attachmentRepo.listByTask(taskId)).toHaveLength(3)
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

  it('导出带附件的 zip：数据文件 + files/ + manifest 齐全', async () => {
    const snapshot = buildSnapshot()
    const { ruleId, versionId } = ruleRepo.create('导出规则', 'it', snapshot, 'v1')
    const taskId = runRepo.ensureTask(ruleId, versionId, null, { minIntervalMs: 0, jitterMs: 0, maxAttempts: 2 })
    const runId = runRepo.createRun(taskId, versionId, 'manual', null)
    const runner = new Runner({
      runId, taskId, ruleVersionId: versionId, snapshot, context,
      resumeCursor: null, emit: () => undefined
    })
    await runner.run()

    // 不带附件：仍是单文件
    const plain = await exportTask(taskId, 'json', false)
    expect(plain.path.endsWith('.json')).toBe(true)
    expect(existsSync(plain.path)).toBe(true)

    // 带附件：zip
    const zip = await exportTask(taskId, 'csv', true)
    expect(zip.path.endsWith('.zip')).toBe(true)
    expect(existsSync(zip.path)).toBe(true)

    const listing = execFileSync('unzip', ['-l', zip.path], { encoding: 'utf8' })
    expect(listing).toContain('data.csv')
    expect(listing).toContain('manifest.json')
    expect(listing).toMatch(/files\/[a-f0-9]+\.pdf/)
    // 内容寻址去重：3 条结果引用同一文件，包里只有 1 个 pdf
    const pdfEntries = listing.match(/files\/[a-f0-9]+\.pdf/g) ?? []
    expect(new Set(pdfEntries).size).toBe(1)

    const manifestRaw = execFileSync('unzip', ['-p', zip.path, 'manifest.json'], { encoding: 'utf8' })
    const manifest = JSON.parse(manifestRaw) as { resultId: string; attachments: { packagePath: string; url: string }[] }[]
    expect(manifest).toHaveLength(3)
    for (const entry of manifest) {
      expect(entry.attachments).toHaveLength(1)
      expect(entry.attachments[0].packagePath).toMatch(/^files\//)
      expect(entry.attachments[0].url).toContain('/files/spec.pdf')
      // 解压出来的附件内容与源文件一致
      const extracted = execFileSync('unzip', ['-p', zip.path, entry.attachments[0].packagePath])
      expect(extracted.toString()).toContain('PDF-BINARY-CONTENT')
    }
  })

  it('附件来源支持 URL 字段模式', async () => {
    const snapshot = buildSnapshot()
    // 把附件规则从元素定位切成 URL 字段
    snapshot.attachments = [
      { id: 'fromField', sourceFieldId: 'fileUrl', attr: 'href', naming: '{filename}' }
    ]
    const { ruleId, versionId } = ruleRepo.create('字段附件规则', 'it', snapshot, 'v1')
    const taskId = runRepo.ensureTask(ruleId, versionId, null, { minIntervalMs: 0, jitterMs: 0, maxAttempts: 2 })
    const runId = runRepo.createRun(taskId, versionId, 'manual', null)
    const runner = new Runner({
      runId, taskId, ruleVersionId: versionId, snapshot, context,
      resumeCursor: null, emit: () => undefined
    })
    await runner.run()
    expect(runRepo.getRun(runId).status).toBe('done')

    const attachments = attachmentRepo.listByTask(taskId)
    expect(attachments).toHaveLength(3)
    expect(attachments.every((a) => a.status === 'done' && a.field_id === 'fromField')).toBe(true)
    expect(attachments.every((a) => a.url.endsWith('/files/spec.pdf'))).toBe(true)
  })

  it('登录 cookie 缺失时暂停，重新确认后续跑完成', async () => {
    const snapshot = buildSnapshot()
    snapshot.attachments = []
    // 要求一个不存在的 cookie，必然判定登录过期
    snapshot.login = { cookieName: 'session_must_exist' }
    const { ruleId, versionId } = ruleRepo.create('登录暂停规则', 'it', snapshot, 'v1')
    const taskId = runRepo.ensureTask(ruleId, versionId, null, { minIntervalMs: 0, jitterMs: 0, maxAttempts: 2 })
    const runId = runRepo.createRun(taskId, versionId, 'manual', null)

    const statuses: string[] = []
    const runner = new Runner({
      runId, taskId, ruleVersionId: versionId, snapshot, context,
      resumeCursor: null,
      emit: (e) => {
        if (e.type === 'status') statuses.push(e.status)
      }
    })

    // 跑到登录检测会挂起，给它一点时间进入暂停态
    const runPromise = runner.run()
    await new Promise((r) => setTimeout(r, 1500))
    expect(runRepo.getRun(runId).status).toBe('paused_login')
    expect(statuses).toContain('paused_login')
    // 暂停期间没有数据入库
    expect(resultRepo.query({ taskId, limit: 10, offset: 0 }).total).toBe(0)

    // 模拟用户补好登录态（写入要求的 cookie）后点继续
    await context.addCookies([
      { name: 'session_must_exist', value: 'restored', domain: '127.0.0.1', path: '/' }
    ])
    runner.notifyLoginResolved()
    await runPromise

    expect(runRepo.getRun(runId).status).toBe('done')
    expect(resultRepo.query({ taskId, limit: 10, offset: 0 }).total).toBe(3)
  })

  it('能采集 iframe 内的列表（framePath 定位）', async () => {
    const framePath = [
      { iframeLocator: css('#content-frame'), name: 'dataframe', urlPattern: 'frame-inner.html' }
    ]
    const snapshot: RuleSnapshot = {
      schemaVersion: 1,
      startUrl: `${listUrl}frame-outer.html`,
      list: {
        container: { ...css('#frame-list'), framePath },
        row: { ...css('.frame-row'), framePath }
      },
      fields: [
        { id: 'title', name: '标题', kind: 'text', locator: { ...css('.f-title'), framePath }, scope: 'list', required: true, dataType: 'string' },
        { id: 'code', name: '编号', kind: 'text', locator: { ...css('.f-code'), framePath }, scope: 'list', dataType: 'string' }
      ],
      pagination: { mode: 'none', maxPages: 1 },
      cleaning: [],
      attachments: [],
      dedupeKey: ['code'],
      retry: { maxAttempts: 2, backoffBaseMs: 50, backoffMaxMs: 200 },
      throttle: { minIntervalMs: 0, jitterMs: 0 }
    }
    const { ruleId, versionId } = ruleRepo.create('iframe 规则', 'it', snapshot, 'v1')
    const taskId = runRepo.ensureTask(ruleId, versionId, null, { minIntervalMs: 0, jitterMs: 0, maxAttempts: 2 })
    const runId = runRepo.createRun(taskId, versionId, 'manual', null)
    const runner = new Runner({
      runId, taskId, ruleVersionId: versionId, snapshot, context,
      resumeCursor: null, emit: () => undefined
    })
    await runner.run()

    expect(runRepo.getRun(runId).status).toBe('done')
    const page = resultRepo.query({ taskId, limit: 10, offset: 0 })
    expect(page.total).toBe(2)
    const codes = page.rows.map((r) => r.data.code).sort()
    expect(codes).toEqual(['FR-001', 'FR-002'])
    expect(page.rows.map((r) => r.data.title)).toEqual(
      expect.arrayContaining(['框架内项目一', '框架内项目二'])
    )
  })

  it('滚动加载：滚到底持续追加行直到收敛', async () => {
    const snapshot: RuleSnapshot = {
      schemaVersion: 1,
      startUrl: `${listUrl}scroll.html`,
      list: { container: css('#scroll-list'), row: css('.scroll-row') },
      fields: [
        { id: 'title', name: '标题', kind: 'text', locator: css('.s-title'), scope: 'list', required: true, dataType: 'string' }
      ],
      pagination: {
        mode: 'scroll',
        maxPages: 20,
        scroll: { container: css('#scroll-list'), maxScrolls: 20, settleMs: 150, noNewRowsRounds: 2 }
      },
      cleaning: [],
      attachments: [],
      dedupeKey: ['title'],
      retry: { maxAttempts: 2, backoffBaseMs: 50, backoffMaxMs: 200 },
      throttle: { minIntervalMs: 0, jitterMs: 0 }
    }
    const { ruleId, versionId } = ruleRepo.create('滚动规则', 'it', snapshot, 'v1')
    const taskId = runRepo.ensureTask(ruleId, versionId, null, { minIntervalMs: 0, jitterMs: 0, maxAttempts: 2 })
    const runId = runRepo.createRun(taskId, versionId, 'manual', null)
    const runner = new Runner({
      runId, taskId, ruleVersionId: versionId, snapshot, context,
      resumeCursor: null, emit: () => undefined
    })
    await runner.run()

    expect(runRepo.getRun(runId).status).toBe('done')
    const page = resultRepo.query({ taskId, limit: 50, offset: 0 })
    // 夹具总共 12 行，全部滚出来并采集
    expect(page.total).toBe(12)
  })

  it('主选择器失效时自动回退到候选选择器', async () => {
    // 第一个候选是页面上不存在的选择器，第二个才是真实的，模拟页面改版后类名变化
    const resilient = {
      candidates: [
        { engine: 'css' as const, value: '.old-class-that-no-longer-exists' },
        { engine: 'css' as const, value: '.title' }
      ]
    }
    const snapshot: RuleSnapshot = {
      schemaVersion: 1,
      startUrl: listUrl,
      list: { container: css('#notice-list'), row: css('li.row') },
      fields: [
        { id: 'title', name: '标题', kind: 'text', locator: resilient, scope: 'list', required: true, dataType: 'string' }
      ],
      pagination: { mode: 'none', maxPages: 1 },
      cleaning: [{ fieldId: 'title', ops: [{ op: 'trim' }] }],
      attachments: [],
      dedupeKey: ['title'],
      retry: { maxAttempts: 2, backoffBaseMs: 50, backoffMaxMs: 200 },
      throttle: { minIntervalMs: 0, jitterMs: 0 }
    }
    const { ruleId, versionId } = ruleRepo.create('候选回退规则', 'it', snapshot, 'v1')
    const taskId = runRepo.ensureTask(ruleId, versionId, null, { minIntervalMs: 0, jitterMs: 0, maxAttempts: 2 })
    const runId = runRepo.createRun(taskId, versionId, 'manual', null)
    const runner = new Runner({
      runId, taskId, ruleVersionId: versionId, snapshot, context,
      resumeCursor: null, emit: () => undefined
    })
    await runner.run()

    // 主选择器失效但候选命中，整行不失败，3 行正常入库
    expect(runRepo.getRun(runId).status).toBe('done')
    expect(resultRepo.query({ taskId, limit: 10, offset: 0 }).total).toBe(3)
  })
})
