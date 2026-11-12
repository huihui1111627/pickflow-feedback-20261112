// 规则快照的核心类型契约，主进程 / preload / 渲染进程共用。
// 引擎只允许读取 rule_versions 里不可变的 RuleSnapshot，禁止读 rules.current_version_id。

export const SCHEMA_VERSION = 1

export type LocatorEngine = 'role' | 'testid' | 'label' | 'text' | 'css' | 'xpath'

export interface CandidateLocator {
  engine: LocatorEngine
  /** role 名称 / text 文本 / css 表达式 / xpath 表达式本体 */
  value: string
  options?: {
    exact?: boolean
    attr?: string
  }
  /** 生成器打分，仅用于调试与脆弱性提示 */
  score?: number
}

export interface FrameRef {
  /** 在父 frame 中定位 <iframe>/<frame> 元素的选择器 */
  iframeLocator: LocatorSpec
  name?: string
  /** iframe src 的 URL 模式，选择器全部失效时兜底匹配 frame */
  urlPattern?: string
}

export interface LocatorSpec {
  /** 有序候选，运行时从前往后试，首个解析成功的胜出 */
  candidates: CandidateLocator[]
  /** 空数组或 undefined 表示主文档 */
  framePath?: FrameRef[]
}

export type ExtractKind = 'text' | 'html' | 'attr'
export type DataType = 'string' | 'number' | 'boolean' | 'date'
export type FieldScope = 'list' | 'detail'

export interface FieldSpec {
  /** 规则内稳定 id，清洗管线 / 附件 / 去重键都引用它 */
  id: string
  name: string
  kind: ExtractKind
  /** kind = 'attr' 时取的属性名，如 href、src、value */
  attr?: string
  locator: LocatorSpec
  scope: FieldScope
  required?: boolean
  dataType: DataType
}

export type CleaningOp =
  | { op: 'trim' }
  | { op: 'regexExtract'; pattern: string; flags?: string; group: number }
  | { op: 'regexReplace'; pattern: string; flags?: string; replacement: string }
  | { op: 'htmlDecode' }
  | { op: 'toType'; target: DataType; dateFormat?: string }
  | { op: 'concat'; sources: string[]; separator: string }
  | { op: 'split'; source: string; separator: string; index: number | 'all' }
  | { op: 'mapEnum'; mapping: Record<string, string>; fallback?: string }
  | { op: 'dedupe'; scope: 'field' | 'composite'; fields?: string[] }

export interface FieldCleaning {
  /** 输出字段 id；组合字段可以新建虚拟 id */
  fieldId: string
  /** 严格有序，全部是纯函数，不允许自定义脚本 */
  ops: CleaningOp[]
}

export type PaginationMode = 'none' | 'click' | 'url' | 'form' | 'scroll'

export interface PaginationSpec {
  mode: PaginationMode
  maxPages: number
  click?: { next: LocatorSpec }
  /** template 含 {page} 占位，如 https://x.test/list?page={page} */
  url?: { template: string; startPage: number; paramName?: string }
  /** form 模式一期只保留类型，二期实现 */
  form?: {
    form: LocatorSpec
    submit: LocatorSpec
    fills: { locator: LocatorSpec; value: string }[]
  }
  scroll?: {
    container?: LocatorSpec
    maxScrolls: number
    settleMs: number
    /** 连续多少轮没有新行就判定滚动到底 */
    noNewRowsRounds: number
  }
}

export interface DetailSpec {
  /** 行内相对的链接定位器，运行时取 href */
  linkLocator: LocatorSpec
  /** MVP 固定新 tab，保留列表页滚动与 DOM 状态；预留 same-page */
  openStrategy: 'new-tab' | 'same-page'
  fields: FieldSpec[]
  framePath?: FrameRef[]
}

export interface AttachmentSpec {
  id: string
  /** 方式一：来自已抽取的 URL 字段 */
  sourceFieldId?: string
  /** 方式二：直接在行内/详情内定位下载元素 */
  locator?: LocatorSpec
  attr: 'href' | 'src'
  allowedExtensions?: string[]
  /** 文件名模板，占位符：{rowIndex} {fieldId} {filename} */
  naming: string
}

export interface LoginDetectionSpec {
  statusCodes?: number[]
  loginUrlPattern?: string
  featureLocator?: LocatorSpec
  cookieName?: string
}

export interface RetrySpec {
  maxAttempts: number
  backoffBaseMs: number
  backoffMaxMs: number
}

export interface ThrottleSpec {
  minIntervalMs: number
  jitterMs: number
}

export interface RuleSnapshot {
  schemaVersion: number
  startUrl: string
  rootFramePath?: FrameRef[]
  list: {
    container: LocatorSpec
    row: LocatorSpec
  }
  fields: FieldSpec[]
  detail?: DetailSpec
  pagination: PaginationSpec
  cleaning: FieldCleaning[]
  attachments: AttachmentSpec[]
  /** fieldId 组合；空数组表示退化为全字段 hash */
  dedupeKey: string[]
  retry: RetrySpec
  throttle: ThrottleSpec
  login?: LoginDetectionSpec
  /** 三期 cron 调度占位 */
  schedule?: { cron: string; timezone: string; enabled: boolean }
}

/** 点选过程中回传的元素描述符（页面侧只负责采集素材，选择器在 Node 侧生成） */
export interface ElementDescriptor {
  tag: string
  id?: string
  role?: string
  accessibleName?: string
  attributes: Record<string, string>
  classList: string[]
  textPreview: string
  outerHtmlPreview: string
  /** DOM 上溯链素材：tag + 稳定属性，供 Node 侧生成结构选择器 */
  ancestry: { tag: string; id?: string; attributes: Record<string, string>; classList: string[] }[]
}

export type PickerMode =
  | 'off'
  | 'list-container'
  | 'row'
  | 'field'
  | 'detail-link'
  | 'pagination'
  | 'frame-scope'
