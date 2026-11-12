import type { ElementHandle, Frame, Locator, Page } from 'playwright'
import type { CandidateLocator, ElementDescriptor } from '../../shared/rule.types'
import { buildRoleCandidate } from './locatorResolve.js'

const HASH_LIKE = /(:r[0-9]+:|^[a-z]+-[0-9a-f]{6,}$|_[0-9a-f]{8,}$)/i
const MEANINGFUL_ROLES = new Set([
  'button', 'link', 'heading', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox',
  'option', 'tab', 'menuitem', 'switch', 'searchbox', 'gridcell', 'columnheader', 'rowheader'
])

// 页面内自包含的路径构建（evaluate 只序列化函数本体，闭包外的 helper 进不去浏览器上下文）
function cssPathInPage(el: Element): string | null {
  const HASH = /(:r[0-9]+:|^[a-z]+-[0-9a-f]{6,}$|_[0-9a-f]{8,}$)/i
  const parts: string[] = []
  let cur: Element | null = el
  while (cur && cur.nodeType === 1) {
    let part = cur.tagName.toLowerCase()
    if (cur.id && !HASH.test(cur.id)) {
      parts.unshift(`#${CSS.escape(cur.id)}`)
      break
    }
    const stableClass = Array.from(cur.classList || []).find((c) => !HASH.test(c))
    if (stableClass) part += `.${CSS.escape(stableClass)}`
    if (cur.parentElement) {
      const sameTag = Array.from(cur.parentElement.children).filter((s) => s.tagName === cur!.tagName)
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(cur) + 1})`
    }
    parts.unshift(part)
    cur = cur.parentElement
    if (parts.length > 6) return null
  }
  return parts.length > 0 ? parts.join(' > ') : null
}

function xpathInPage(el: Element): string | null {
  const parts: string[] = []
  let cur: Element | null = el
  while (cur && cur.nodeType === 1) {
    let part = cur.tagName.toLowerCase()
    if (cur.parentElement) {
      const sameTag = Array.from(cur.parentElement.children).filter((s) => s.tagName === cur!.tagName)
      if (sameTag.length > 1) part += `[${sameTag.indexOf(cur) + 1}]`
    }
    parts.unshift(part)
    cur = cur.parentElement
    if (parts.length > 6) return null
  }
  return parts.length ? parts.join('/') : null
}

// 行内相对路径：this 是行容器，pickedEl 是被点元素。自包含，不引用兄弟函数。
// 参数声明为 Node 以兼容 ElementHandle<Node> 的 evaluate 签名，运行时一定是 Element。
function relativeCssInPage(rowEl: Node, pickedEl: Node): string | null {
  const row = rowEl as Element
  const HASH = /(:r[0-9]+:|^[a-z]+-[0-9a-f]{6,}$|_[0-9a-f]{8,}$)/i
  const parts: string[] = []
  let cur: Element | null = pickedEl as Element
  while (cur && cur.nodeType === 1) {
    if (cur === row) break
    let part = cur.tagName.toLowerCase()
    const stableClass = Array.from(cur.classList || []).find((c) => !HASH.test(c))
    if (stableClass) part += `.${CSS.escape(stableClass)}`
    if (cur.parentElement) {
      const sameTag = Array.from(cur.parentElement.children).filter((s) => s.tagName === cur!.tagName)
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(cur) + 1})`
    }
    parts.unshift(part)
    cur = cur.parentElement
    if (parts.length > 6) return null
  }
  return parts.length ? parts.join(' > ') : null
}

function relativeXpathInPage(rowEl: Node, pickedEl: Node): string | null {
  const row = rowEl as Element
  const parts: string[] = []
  let cur: Element | null = pickedEl as Element
  while (cur && cur.nodeType === 1) {
    if (cur === row) break
    let part = cur.tagName.toLowerCase()
    if (cur.parentElement) {
      const sameTag = Array.from(cur.parentElement.children).filter((s) => s.tagName === cur!.tagName)
      if (sameTag.length > 1) part += `[${sameTag.indexOf(cur) + 1}]`
    }
    parts.unshift(part)
    cur = cur.parentElement
    if (parts.length > 6) return null
  }
  return parts.length ? './' + parts.join('/') : null
}

type CountScope = Page | Frame | Locator | ElementHandle

async function countOf(scope: CountScope, selector: string): Promise<number> {
  try {
    // ElementHandle 没有 locator()，用 $$（同样支持 text=/role= 等引擎，且限定子树）
    if ('locator' in scope) return await scope.locator(selector).count()
    return (await scope.$$(selector)).length
  } catch {
    return 0
  }
}

async function uniqueIn(scope: CountScope, selector: string): Promise<boolean> {
  return (await countOf(scope, selector)) === 1
}

// 校验候选并按优先级保留能唯一定位的
async function filterUnique(scope: CountScope, candidates: CandidateLocator[]): Promise<CandidateLocator[]> {
  const kept: CandidateLocator[] = []
  for (const c of candidates) {
    const selector = selectorString(c)
    if (selector && (await uniqueIn(scope, selector))) kept.push(c)
  }
  return kept
}

function selectorString(c: CandidateLocator): string {
  switch (c.engine) {
    case 'role': {
      let s = `role=${c.value}`
      if (c.options?.attr) s += `[name=${JSON.stringify(c.options.attr)}]`
      return s
    }
    case 'testid':
      return `data-testid=${c.value}`
    case 'label':
      return `label=${c.value}`
    case 'text':
      return c.options?.exact ? `text=${JSON.stringify(c.value)}` : `text=${c.value}`
    case 'xpath':
      return `xpath=${c.value}`
    case 'css':
    default:
      return c.value
  }
}

function attrCandidates(desc: ElementDescriptor): CandidateLocator[] {
  const out: CandidateLocator[] = []
  const tag = desc.tag
  for (const attr of ['data-testid', 'data-test', 'name', 'aria-label', 'title']) {
    const v = desc.attributes[attr]
    if (!v) continue
    if (attr === 'data-testid' || attr === 'data-test') {
      out.push({ engine: 'testid', value: v, score: 90 })
    } else if (attr === 'name' || attr === 'aria-label') {
      out.push({ engine: 'css', value: `${tag}[${attr}="${v.replace(/"/g, '\\"')}"]`, score: 70 })
    }
  }
  if (desc.id && !HASH_LIKE.test(desc.id)) {
    out.push({ engine: 'css', value: `#${CSS.escape(desc.id)}`, score: 95 })
  }
  return out
}

export interface GeneratedSpec {
  candidates: CandidateLocator[]
  unique: boolean
}

// 全局选择器（容器、翻页按钮、详情链接等）
export async function generateGlobalSpec(
  page: Page | Frame,
  element: ElementHandle,
  desc: ElementDescriptor
): Promise<GeneratedSpec> {
  const candidates: CandidateLocator[] = []

  if (desc.role && MEANINGFUL_ROLES.has(desc.role)) {
    candidates.push(buildRoleCandidate(desc.role, desc.accessibleName, true))
  }
  candidates.push(...attrCandidates(desc))

  if ((desc.tag === 'a' || desc.tag === 'button') && desc.textPreview && desc.textPreview.length <= 40) {
    candidates.push({ engine: 'text', value: desc.textPreview, options: { exact: true }, score: 75 })
  }

  const css = await element.evaluate(cssPathInPage)
  if (css) candidates.push({ engine: 'css', value: css, score: 50 })
  const xpath = await element.evaluate(xpathInPage)
  if (xpath) candidates.push({ engine: 'xpath', value: xpath, score: 20 })

  const ordered = dedupeCandidates(candidates).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  const kept = await filterUnique(page, ordered)
  return { candidates: kept, unique: kept.length > 0 }
}

// 行内相对选择器：以 row 为作用域，校验行内唯一
export async function generateRelativeSpec(
  row: ElementHandle,
  element: ElementHandle,
  desc: ElementDescriptor
): Promise<GeneratedSpec> {
  const candidates: CandidateLocator[] = []

  if (desc.role && MEANINGFUL_ROLES.has(desc.role)) {
    candidates.push(buildRoleCandidate(desc.role, desc.accessibleName, true))
  }
  const testid = desc.attributes['data-testid'] ?? desc.attributes['data-test']
  if (testid) candidates.push({ engine: 'testid', value: testid, score: 90 })

  const relCss = await row.evaluate(relativeCssInPage, element)
  if (relCss) candidates.push({ engine: 'css', value: relCss, score: 60 })

  const relXpath = await row.evaluate(relativeXpathInPage, element)
  if (relXpath) candidates.push({ engine: 'xpath', value: relXpath, score: 20 })

  const ordered = dedupeCandidates(candidates).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  const kept = await filterUnique(row, ordered)
  return { candidates: kept, unique: kept.length > 0 }
}

function dedupeCandidates(list: CandidateLocator[]): CandidateLocator[] {
  const seen = new Set<string>()
  const out: CandidateLocator[] = []
  for (const c of list) {
    const key = `${c.engine}:${c.value}:${c.options?.attr ?? ''}:${c.options?.exact ?? ''}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push(c)
    }
  }
  return out
}
