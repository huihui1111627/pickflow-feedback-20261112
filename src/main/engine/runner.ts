import type { BrowserContext, Page } from 'playwright'
import type { RuleSnapshot } from '../../shared/rule.types.js'
import type { CheckpointCursor, RunEvent, RunStats } from '../../shared/run.types.js'
import { runRepo } from '../db/repositories/run.repo.js'
import { resultRepo } from '../db/repositories/result.repo.js'
import { applyCleanings, buildDedupeKey } from './cleaning.js'
import { extractDetailFields, extractListRows } from './extract.js'
import { detectLoginExpired, isLoginStatusCode } from './loginDetect.js'
import { resolveFirstAvailable, resolveOnPage, resolveSpec } from '../browser/locatorResolve.js'

// 采集执行器：一个实例对应一次 run。
// 只依赖 RuleSnapshot 不可变快照，规则后续被修改不影响本次运行。

export interface RunnerOptions {
  runId: string
  taskId: string
  ruleVersionId: string
  snapshot: RuleSnapshot
  context: BrowserContext
  /** 续跑时传入父 run 的检查点，尽力快进到断点；正确性由 results 唯一约束兜底 */
  resumeCursor?: CheckpointCursor | null
  emit: (event: RunEvent) => void
}

const EMPTY_STATS: RunStats = {
  pagesProcessed: 0,
  rowsExtracted: 0,
  rowsUpserted: 0,
  rowsFailed: 0,
  attachmentsDone: 0,
  attachmentsFailed: 0
}

export class Runner {
  private stopFlag = false
  private loginWaiter: { resolve: () => void } | null = null
  private stats: RunStats = { ...EMPTY_STATS }

  constructor(private opts: RunnerOptions) {}

  requestStop(): void {
    this.stopFlag = true
    // 停止时如果正卡在登录等待，直接放行让主循环退出
    this.loginWaiter?.resolve()
  }

  // 用户在浏览器里重新登录后点继续
  notifyLoginResolved(): void {
    this.loginWaiter?.resolve()
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', step: string, message: string): void {
    const at = new Date().toISOString()
    runRepo.appendLog(this.opts.runId, level, step, message)
    this.opts.emit({ type: 'log', runId: this.opts.runId, level, step, message, at })
  }

  private setStatus(status: Parameters<typeof runRepo.updateStatus>[1], errorSummary?: string): void {
    runRepo.updateStatus(this.opts.runId, status, errorSummary)
    this.opts.emit({ type: 'status', runId: this.opts.runId, status })
  }

  private flushStats(currentUrl: string): void {
    runRepo.updateStats(this.opts.runId, this.stats)
    this.opts.emit({ type: 'progress', runId: this.opts.runId, stats: { ...this.stats }, currentUrl })
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms))
  }

  private async throttle(): Promise<void> {
    const { minIntervalMs, jitterMs } = this.opts.snapshot.throttle
    await this.sleep(minIntervalMs + Math.floor(Math.random() * jitterMs))
  }

  private async withRetry<T>(step: string, fn: () => Promise<T>): Promise<T> {
    const { maxAttempts, backoffBaseMs, backoffMaxMs } = this.opts.snapshot.retry
    let lastErr: unknown
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn()
      } catch (err) {
        lastErr = err
        const msg = err instanceof Error ? err.message : String(err)
        this.log('warn', step, `第 ${attempt}/${maxAttempts} 次尝试失败: ${msg}`)
        if (attempt < maxAttempts) {
          const delay = Math.min(backoffBaseMs * 2 ** (attempt - 1), backoffMaxMs)
          await this.sleep(delay)
        }
      }
    }
    throw lastErr
  }

  // 登录检测 → 暂停 → 等用户重新登录 → 继续
  private async checkLogin(page: Page): Promise<void> {
    const reason = await detectLoginExpired(page, this.opts.snapshot.login)
    if (!reason || this.stopFlag) return

    this.log('warn', 'login', `检测到登录过期: ${reason}，任务暂停，请在浏览器中重新登录后点继续`)
    this.setStatus('paused_login')
    this.opts.emit({ type: 'login-expired', runId: this.opts.runId, reason })

    await new Promise<void>((resolve) => {
      this.loginWaiter = { resolve }
    })
    this.loginWaiter = null
    if (this.stopFlag) return

    this.log('info', 'login', '用户已确认重新登录，继续采集')
    this.setStatus('running')
  }

  async run(): Promise<void> {
    const { runId, snapshot, context } = this.opts
    this.setStatus('running')
    this.log('info', 'init', `开始采集: ${snapshot.startUrl}`)

    const page = await context.newPage()
    try {
      await this.gotoWithLoginCheck(page, snapshot.startUrl)

      const cursor = this.opts.resumeCursor ?? null
      let startPage = 1
      let skipRows = 0
      if (cursor) {
        startPage = cursor.page
        skipRows = cursor.rowIndex
        this.log('info', 'resume', `从断点续跑: 第 ${startPage} 页第 ${skipRows + 1} 行`)
        await this.fastForward(page, cursor)
      }

      await this.pageLoop(page, startPage, skipRows)

      if (this.stopFlag) {
        this.setStatus('stopped')
        this.log('info', 'stop', '任务已停止，检查点已保存，可随时续跑')
      } else {
        this.setStatus('done')
        this.log('info', 'done', `采集完成: 入库 ${this.stats.rowsUpserted} 条，失败 ${this.stats.rowsFailed} 条`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (this.stopFlag) {
        this.setStatus('stopped')
      } else {
        this.setStatus('error', msg)
        this.log('error', 'fatal', msg)
        this.opts.emit({ type: 'error', runId: runId, step: 'fatal', message: msg, at: new Date().toISOString() })
      }
    } finally {
      this.flushStats('')
      await page.close().catch(() => undefined)
    }
  }

  private async gotoWithLoginCheck(page: Page, url: string): Promise<void> {
    const response = await this.withRetry('goto', () =>
      page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    )
    if (response && isLoginStatusCode(response.status(), this.opts.snapshot.login)) {
      this.log('warn', 'login', `导航返回登录态状态码: ${response.status()}`)
    }
    await this.checkLogin(page)
  }

  // 续跑快进：把列表页状态恢复到断点时的页码/滚动位置
  private async fastForward(page: Page, cursor: CheckpointCursor): Promise<void> {
    const { pagination } = this.opts.snapshot
    if (pagination.mode === 'url' && pagination.url) {
      await this.gotoWithLoginCheck(page, pagination.url.template.replace('{page}', String(cursor.page)))
    } else if (pagination.mode === 'click' && pagination.click) {
      for (let i = 1; i < cursor.page; i++) {
        await this.clickNext(page)
      }
    } else if (pagination.mode === 'scroll') {
      await this.scrollToLoad(page, cursor.scrolls)
    }
  }

  private async pageLoop(page: Page, startPage: number, initialSkipRows: number): Promise<void> {
    const { snapshot } = this.opts
    const { pagination } = snapshot
    let pageNo = startPage
    let skipRows = initialSkipRows

    for (;;) {
      if (this.stopFlag) return

      if (pagination.mode === 'scroll') {
        await this.scrollToLoad(page, 0)
      }

      const rows = await this.withRetry('extract-list', () =>
        extractListRows(page, snapshot)
      )
      if (rows.length === 0 && pageNo === startPage) {
        throw new Error('列表容器或行选择器没有匹配到任何行，请检查规则')
      }

      for (const row of rows) {
        if (this.stopFlag) return
        if (row.index < skipRows) continue

        const itemKey = `p${pageNo}:r${row.index}`
        if (runRepo.isItemDone(this.opts.runId, itemKey)) continue

        try {
          await this.processRow(row)
          runRepo.markItem(this.opts.runId, itemKey, 'list_page', 'done')
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          runRepo.markItem(this.opts.runId, itemKey, 'list_page', 'failed', msg)
          this.stats.rowsFailed++
          this.log('error', 'row', `第 ${pageNo} 页第 ${row.index + 1} 行失败: ${msg}`)
        }

        this.stats.pagesProcessed = pageNo
        this.flushStats(page.url())
        runRepo.saveCheckpoint(this.opts.runId, {
          phase: 'list',
          page: pageNo,
          url: page.url(),
          scrolls: 0,
          rowIndex: row.index
        })
        await this.throttle()
      }
      skipRows = 0

      // 翻页
      if (pagination.mode === 'none' || pagination.mode === 'scroll') return
      if (pageNo >= pagination.maxPages) return

      if (pagination.mode === 'url' && pagination.url) {
        pageNo++
        await this.gotoWithLoginCheck(page, pagination.url.template.replace('{page}', String(pageNo)))
      } else if (pagination.mode === 'click' && pagination.click) {
        const moved = await this.clickNext(page)
        if (!moved) {
          this.log('info', 'paginate', '下一页按钮不可用，翻页结束')
          return
        }
        pageNo++
      } else {
        return
      }
    }
  }

  private async processRow(row: {
    index: number
    data: Record<string, string | null>
    detailHref: string | null
    sourceUrl: string
  }): Promise<void> {
    const { snapshot } = this.opts
    let data: Record<string, unknown> = { ...row.data }
    let sourceUrl = row.sourceUrl

    // 必填字段校验
    for (const field of snapshot.fields) {
      if (field.scope === 'list' && field.required && (data[field.id] === null || data[field.id] === '')) {
        throw new Error(`必填字段为空: ${field.name}`)
      }
    }

    // 详情页
    if (snapshot.detail && row.detailHref) {
      const detailData = await this.withRetry('detail', async () => {
        const tab = await this.opts.context.newPage()
        try {
          await this.gotoWithLoginCheck(tab, row.detailHref!)
          return await extractDetailFields(tab, snapshot.detail!.fields)
        } finally {
          await tab.close().catch(() => undefined)
        }
      })
      data = { ...data, ...detailData }
      sourceUrl = row.detailHref
    }

    // 清洗管线
    const cleaned = applyCleanings(data, snapshot.cleaning)
    const dedupeKey = buildDedupeKey(cleaned, snapshot.dedupeKey)

    const { inserted } = resultRepo.upsert(
      {
        taskId: this.opts.taskId,
        runId: this.opts.runId,
        ruleVersionId: this.opts.ruleVersionId,
        data: cleaned,
        dedupeKey,
        sourceUrl,
        collectedAt: new Date().toISOString()
      },
      snapshot.dedupeKey
    )

    this.stats.rowsExtracted++
    if (inserted) this.stats.rowsUpserted++
  }

  private async clickNext(page: Page): Promise<boolean> {
    const spec = this.opts.snapshot.pagination.click?.next
    if (!spec) return false
    const found = await resolveFirstAvailable(page, spec)
    if (!found) return false
    await this.withRetry('paginate-click', async () => {
      await found.locator.first().click({ timeout: 10_000 })
      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined)
    })
    await this.checkLogin(page)
    return true
  }

  // 滚动加载：滚到底，连续 noNewRowsRounds 轮行数不再增长就停；targetScrolls > 0 表示续跑快进，滚固定轮数
  private async scrollToLoad(page: Page, targetScrolls: number): Promise<void> {
    const scrollSpec = this.opts.snapshot.pagination.scroll
    if (!scrollSpec) return
    const maxScrolls = targetScrolls > 0 ? targetScrolls : scrollSpec.maxScrolls
    const container = resolveOnPage(page, this.opts.snapshot.list.container)
    const rowLocator = resolveSpec(container, this.opts.snapshot.list.row)
    let noNewRounds = 0
    let lastCount = await rowLocator.count().catch(() => 0)

    for (let i = 0; i < maxScrolls; i++) {
      if (this.stopFlag) return
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await this.sleep(scrollSpec.settleMs)

      const count = await rowLocator.count().catch(() => 0)
      if (count <= lastCount) {
        noNewRounds++
        if (targetScrolls === 0 && noNewRounds >= scrollSpec.noNewRowsRounds) return
      } else {
        noNewRounds = 0
      }
      lastCount = count
    }
  }
}
