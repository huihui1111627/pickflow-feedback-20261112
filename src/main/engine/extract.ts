import type { Locator, Page } from 'playwright'
import type { FieldSpec, RuleSnapshot } from '../../shared/rule.types.js'
import { resolveFirstAvailable, resolveOnPage, resolveSpec } from '../browser/locatorResolve.js'

// 字段抽取：点选预览与正式采集共用，保证"预览即所得"。
// 所有函数对单个字段失败宽容（返回 null），由上层按 required 决定是否判整行失败。

export async function extractField(scope: Locator, field: FieldSpec): Promise<string | null> {
  const found = await resolveFirstAvailable(scope, field.locator)
  if (!found) return null
  const el = found.locator.first()
  try {
    switch (field.kind) {
      case 'text':
        return await el.innerText()
      case 'html':
        return await el.innerHTML()
      case 'attr': {
        if (!field.attr) return null
        return await el.getAttribute(field.attr)
      }
    }
  } catch {
    return null
  }
}

// 在一行（或一个详情页根）上抽取一组字段
export async function extractFields(scope: Locator, fields: FieldSpec[]): Promise<Record<string, string | null>> {
  const data: Record<string, string | null> = {}
  for (const field of fields) {
    data[field.id] = await extractField(scope, field)
  }
  return data
}

export interface RawRow {
  index: number
  data: Record<string, string | null>
  /** 详情链接 href（配了 detail 才有），来源追溯与详情采集都用它 */
  detailHref: string | null
  /** 行内链接元素不可定位时退化为列表页 URL */
  sourceUrl: string
}

// 从列表页抽取全部行。listFields 只取 scope === 'list' 的字段。
export async function extractListRows(
  page: Page,
  snapshot: Pick<RuleSnapshot, 'list' | 'fields' | 'detail'>,
  maxRows = 0
): Promise<RawRow[]> {
  const container = resolveOnPage(page, snapshot.list.container)
  const rowLocator = resolveSpec(container, snapshot.list.row)
  const count = await rowLocator.count()
  const limit = maxRows > 0 ? Math.min(count, maxRows) : count
  const listFields = snapshot.fields.filter((f) => f.scope === 'list')

  const rows: RawRow[] = []
  for (let i = 0; i < limit; i++) {
    const row = rowLocator.nth(i)
    const data = await extractFields(row, listFields)

    let detailHref: string | null = null
    if (snapshot.detail) {
      const link = await resolveFirstAvailable(row, snapshot.detail.linkLocator)
      detailHref = link ? await link.locator.first().getAttribute('href') : null
      if (detailHref) detailHref = new URL(detailHref, page.url()).href
    }

    rows.push({ index: i, data, detailHref, sourceUrl: page.url() })
  }
  return rows
}

// 详情页字段抽取：在新 tab 里打开 href，抽完关闭，列表页状态不受影响
export async function extractDetailFields(
  page: Page,
  fields: FieldSpec[]
): Promise<Record<string, string | null>> {
  const root = page.locator(':root')
  return extractFields(root, fields.filter((f) => f.scope === 'detail'))
}
