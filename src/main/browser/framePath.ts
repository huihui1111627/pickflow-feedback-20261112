import type { ElementHandle, Frame, Page } from 'playwright'
import type { FrameRef, LocatorSpec } from '../../shared/rule.types'
import { generateGlobalSpec } from './selectorGen.js'

// 点选时：从目标 Frame 沿 parentFrame 上溯，为每层 iframe 元素生成定位器，
// 还原成 主文档 -> 目标 frame 的 FrameRef 链。
export async function buildFramePath(frame: Frame): Promise<FrameRef[]> {
  const chain: FrameRef[] = []
  let current: Frame | null = frame

  while (current) {
    const parent: Frame | null = current.parentFrame()
    if (!parent) break

    const frameElement = (await current.frameElement()) as ElementHandle
    const spec: LocatorSpec = { candidates: [] }
    try {
      const { candidates } = await generateGlobalSpec(parent, frameElement, {
        tag: 'iframe',
        attributes: {},
        classList: [],
        textPreview: '',
        outerHtmlPreview: '',
        ancestry: []
      })
      spec.candidates = candidates
    } catch {
      // iframe 元素无法唯一定位时保留空候选，靠 name/urlPattern 兜底
    }

    let name: string | undefined
    let urlPattern: string | undefined
    try {
      name = (await frameElement.getAttribute('name')) ?? undefined
      const src = await frameElement.getAttribute('src')
      if (src) urlPattern = src
    } catch {
      // 跨域 frame 取属性失败可忽略
    }

    chain.unshift({ iframeLocator: spec, name, urlPattern })
    current = parent
  }

  return chain
}

// 运行时按 name / urlPattern 从 page 找到目标 Frame（frameLocator 选择器全失效时的兜底）
export function findFrameByPath(page: Page, path: FrameRef[]): Frame | null {
  let siblings: Frame[] = page.frames()
  let current: Frame = page.mainFrame()

  for (const ref of path) {
    const next = siblings.find((f: Frame) => {
      if (ref.name && f.name() === ref.name) return true
      if (ref.urlPattern && f.url().includes(ref.urlPattern)) return true
      return false
    })
    if (!next) return null
    current = next
    siblings = current.childFrames()
  }
  return current
}
