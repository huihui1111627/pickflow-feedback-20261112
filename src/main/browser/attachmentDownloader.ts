import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, extname, basename } from 'node:path'
import type { BrowserContext, Locator, Page } from 'playwright'
import type { AttachmentSpec } from '../../shared/rule.types.js'
import { taskAttachmentsDir } from '../services/paths.js'
import { attachmentRepo } from '../db/repositories/attachment.repo.js'
import { resolveFirstAvailable } from './locatorResolve.js'

// 附件下载：与采集共用同一个 BrowserContext，请求自动带上登录 cookie。
// 文件按 sha256 内容寻址落盘，重跑同一行命中 UNIQUE(result_id, url) 直接跳过，
// 不会产生重复下载。

export interface AttachmentTarget {
  url: string
  /** 行内/详情内定位到的下载元素（locator 模式才有），用于触发浏览器原生下载 */
  locator?: Locator
}

export interface DownloadOutcome {
  ok: boolean
  url: string
  filename: string
  localPath: string | null
  mime: string | null
  bytes: number | null
  hashSha256: string | null
  error?: string
}

function hashBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function safeFilename(name: string): string {
  return basename(name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 180) || 'file'
}

function extAllowed(url: string, allowed: string[] | undefined): boolean {
  if (!allowed || allowed.length === 0) return true
  const ext = extname(new URL(url).pathname).toLowerCase().replace('.', '')
  return allowed.includes(ext)
}

// 从一行已抽取数据 + 页面里解析出本次要下载的 URL 列表
export async function resolveAttachmentUrls(
  page: Page,
  spec: AttachmentSpec,
  rowData: Record<string, unknown>
): Promise<string[]> {
  if (spec.sourceFieldId) {
    const v = rowData[spec.sourceFieldId]
    return typeof v === 'string' && v.trim() ? [new URL(v.trim(), page.url()).href] : []
  }
  if (spec.locator) {
    const found = await resolveFirstAvailable(page, spec.locator)
    if (!found) return []
    const attrs = await found.locator.evaluateAll(
      (els, attr) => els.map((el) => el.getAttribute(attr)).filter((v): v is string => !!v),
      spec.attr
    )
    return attrs.map((u) => new URL(u, page.url()).href)
  }
  return []
}

function renderNaming(template: string, ctx: { rowIndex: number; fieldId: string; filename: string }): string {
  return template
    .replaceAll('{rowIndex}', String(ctx.rowIndex))
    .replaceAll('{fieldId}', ctx.fieldId)
    .replaceAll('{filename}', ctx.filename)
}

export class AttachmentDownloader {
  constructor(
    private context: BrowserContext,
    private taskId: string
  ) {}

  // 下载单个附件并登记。已存在且落盘成功的附件直接复用，不重复请求。
  async downloadOne(args: {
    resultId: string
    spec: AttachmentSpec
    url: string
    rowIndex: number
  }): Promise<DownloadOutcome> {
    const { resultId, spec, url, rowIndex } = args

    if (!extAllowed(url, spec.allowedExtensions)) {
      return { ok: false, url, filename: '', localPath: null, mime: null, bytes: null, hashSha256: null, error: '扩展名不在允许列表' }
    }

    // 同一结果行同一 URL 已成功下载过，直接复用，不重复请求
    const existing = attachmentRepo.listByResult(resultId).find((a) => a.url === url && a.status === 'done' && a.local_path)
    if (existing) {
      return {
        ok: true,
        url,
        filename: existing.filename,
        localPath: existing.local_path,
        mime: existing.mime,
        bytes: existing.bytes,
        hashSha256: existing.hash_sha256
      }
    }

    const rawName = safeFilename(decodeURIComponent(basename(new URL(url).pathname)) || 'attachment')
    const filename = safeFilename(renderNaming(spec.naming, { rowIndex, fieldId: spec.id, filename: rawName }))

    try {
      // 走 context.request，cookie/会话与页面共享，适合绝大多数直链下载
      const resp = await this.context.request.get(url, { timeout: 60_000, maxRedirects: 5 })
      if (!resp.ok()) throw new Error(`HTTP ${resp.status()}`)
      const body = Buffer.from(await resp.body())
      const hashSha256 = hashBuffer(body)

      const dir = taskAttachmentsDir(this.taskId)
      const ext = extname(rawName)
      const storedName = `${hashSha256.slice(0, 16)}${ext}`
      const localPath = join(dir, storedName)
      await mkdir(dir, { recursive: true })
      await writeFile(localPath, body)

      const mime = resp.headers()['content-type'] ?? null
      attachmentRepo.upsert({
        resultId,
        fieldId: spec.id,
        url,
        filename,
        localPath,
        mime,
        bytes: body.length,
        hashSha256,
        status: 'done'
      })
      return { ok: true, url, filename, localPath, mime, bytes: body.length, hashSha256 }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      attachmentRepo.upsert({
        resultId,
        fieldId: spec.id,
        url,
        filename,
        localPath: null,
        mime: null,
        bytes: null,
        hashSha256: null,
        status: 'failed'
      })
      return { ok: false, url, filename, localPath: null, mime: null, bytes: null, hashSha256: null, error: msg }
    }
  }

  // 失败附件的临时文件清理工具，预留重试场景使用
  async cleanup(path: string): Promise<void> {
    await rm(path, { force: true }).catch(() => undefined)
  }
}
