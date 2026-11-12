import type { PreviewRequest, PreviewRow } from '../../shared/ipc.contract.js'
import { playwrightManager } from '../browser/PlaywrightManager.js'
import { extractListRows } from '../engine/extract.js'
import { applyCleanings } from '../engine/cleaning.js'
import type { FieldCleaning } from '../../shared/rule.types.js'

// 点选预览：在当前页面跑一遍提取 + 清洗，不入库。
// 与正式采集共用 extract/cleaning，预览结果就是运行结果。

const PREVIEW_ROWS = 5

export async function previewExtract(req: PreviewRequest & { cleaning?: FieldCleaning[] }): Promise<{ rows: PreviewRow[] }> {
  const { page } = playwrightManager.active
  const raw = await extractListRows(page, req.snapshot, PREVIEW_ROWS)

  const rows: PreviewRow[] = raw.map((row) => {
    const cleaned = req.cleaning ? applyCleanings(row.data, req.cleaning) : row.data
    const data: Record<string, string | null> = {}
    for (const [k, v] of Object.entries(cleaned)) {
      data[k] = v === null || v === undefined ? null : String(v)
    }
    return { index: row.index, data, sourceUrl: row.sourceUrl }
  })
  return { rows }
}
