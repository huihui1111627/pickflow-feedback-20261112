import type { Frame, FrameLocator, Locator, Page } from 'playwright'
import type { CandidateLocator, FrameRef, LocatorSpec } from '../../shared/rule.types'

// 把规则里的 LocatorSpec 解析成 Playwright Locator。
// 点选校验与正式采集共用这一个解析入口，保证"所选即所跑"。

type Scope = Page | Frame | FrameLocator | Locator

function escapeAttr(value: string): string {
  return value.replace(/["\\]/g, '\\$&')
}

// role 引擎约定：value 存 role 名称，options.attr 存 accessible name
export function buildRoleCandidate(role: string, accessibleName: string | undefined, exact = false): CandidateLocator {
  return {
    engine: 'role',
    value: role,
    options: accessibleName ? { attr: accessibleName, exact } : { exact }
  }
}

function roleOptions(c: CandidateLocator): Parameters<Page['getByRole']>[1] {
  const opts: { name?: string; exact?: boolean } = {}
  if (c.options?.attr) opts.name = c.options.attr
  if (c.options?.exact) opts.exact = true
  return opts as Parameters<Page['getByRole']>[1]
}

// 转成 Playwright 选择器字符串；frameLocator 链只接受字符串
export function candidateToSelector(c: CandidateLocator): string {
  switch (c.engine) {
    case 'role': {
      let s = `role=${c.value}`
      if (c.options?.attr) s += `[name="${escapeAttr(c.options.attr)}"]`
      if (c.options?.exact) s += '[exact]'
      return s
    }
    case 'testid':
      return `data-testid=${c.value}`
    case 'label':
      return c.options?.exact ? `label=${JSON.stringify(c.value)}` : `label=${c.value}`
    case 'text':
      return c.options?.exact ? `text=${JSON.stringify(c.value)}` : `text=${c.value}`
    case 'xpath':
      return `xpath=${c.value}`
    case 'css':
    default:
      return c.value
  }
}

function applyCandidate(scope: Scope, c: CandidateLocator): Locator {
  switch (c.engine) {
    case 'role':
      return scope.getByRole(c.value as Parameters<Page['getByRole']>[0], roleOptions(c))
    case 'testid':
      return scope.getByTestId(c.value)
    case 'label':
      return scope.getByLabel(c.value, { exact: c.options?.exact })
    case 'text':
      return scope.getByText(c.value, { exact: c.options?.exact })
    case 'xpath':
      return scope.locator(`xpath=${c.value}`)
    case 'css':
    default:
      return scope.locator(c.value)
  }
}

function resolveFrameChain(page: Page, framePath: FrameRef[] | undefined): Scope {
  if (!framePath || framePath.length === 0) return page
  let scope: Scope = page
  for (const ref of framePath) {
    const first = ref.iframeLocator.candidates[0]
    scope = scope.frameLocator(candidateToSelector(first))
  }
  return scope
}

export function resolveSpec(scope: Scope, spec: LocatorSpec): Locator {
  if (spec.candidates.length === 0) throw new Error('LocatorSpec 没有候选选择器')
  return applyCandidate(scope, spec.candidates[0])
}

// 完整解析：page + framePath + 字段候选，引擎抽取时使用
export function resolveOnPage(page: Page, spec: LocatorSpec): Locator {
  const scope = resolveFrameChain(page, spec.framePath)
  return resolveSpec(scope, spec)
}

export function resolveInFrame(frame: Frame, spec: LocatorSpec): Locator {
  return resolveSpec(frame, spec)
}

// 按候选顺序尝试，返回第一个 count>0 的 Locator 及下标；全部失效返回 null。
// 三期"选择器自愈"就靠这里的候选数组逐个兜底。
export async function resolveFirstAvailable(
  scope: Scope,
  spec: LocatorSpec
): Promise<{ locator: Locator; candidateIndex: number } | null> {
  for (let i = 0; i < spec.candidates.length; i++) {
    const locator = applyCandidate(scope, spec.candidates[i])
    try {
      const count = await locator.count()
      if (count > 0) return { locator, candidateIndex: i }
    } catch {
      // 单个候选语法失效不影响后续候选
    }
  }
  return null
}
