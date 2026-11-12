import { chromium, type BrowserContext, type Page } from 'playwright'
import { profileDir } from '../services/paths.js'

// 管理 Playwright persistent context 的生命周期。
// 点选与正式采集共用同一个 context / Locator 引擎，避免重放漂移。
// 同一 profile 同时只允许一个 context（Playwright 自身也会锁 userDataDir）。

export interface ManagedContext {
  context: BrowserContext
  page: Page
  profileId: string
}

export class PlaywrightManager {
  private current: ManagedContext | null = null

  isRunning(): boolean {
    return this.current !== null
  }

  get active(): ManagedContext {
    if (!this.current) throw new Error('浏览器尚未启动，请先开始点选会话')
    return this.current
  }

  async start(profileId: string): Promise<ManagedContext> {
    if (this.current) return this.current

    const userDataDir = profileDir(profileId)
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      viewport: null,
      // 留足自动化检测与下载行为的常规配置
      acceptDownloads: true
    })

    // 没有任何 tab 时补一个，避免 context.pages() 为空
    const page = context.pages()[0] ?? (await context.newPage())
    this.current = { context, page, profileId }

    context.on('close', () => {
      if (this.current?.context === context) this.current = null
    })

    return this.current
  }

  async stop(): Promise<void> {
    if (!this.current) return
    const { context } = this.current
    this.current = null
    await context.close().catch(() => undefined)
  }

  async navigate(url: string): Promise<void> {
    await this.active.page.goto(url, { waitUntil: 'domcontentloaded' })
  }
}

export const playwrightManager = new PlaywrightManager()
