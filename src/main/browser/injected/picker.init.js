// 该脚本通过 context.addInitScript 注入每个 frame（含跨域），在页面脚本之前执行。
// 职责：hover 高亮、点击拦截、采集元素描述符。不生成最终选择器——素材回传 Node 侧生成。
;(() => {
  if (window.__pickflowInstalled) return
  window.__pickflowInstalled = true

  let mode = 'off'
  let pendingFieldId = null
  let overlay = null
  const elementRegistry = new Map()
  let elementSeq = 0

  const HASH_LIKE = /(:r[0-9]+:|^[a-z]+-[0-9a-f]{6,}$|_[0-9a-f]{8,}$)/i

  function stableClasses(el) {
    return Array.from(el.classList || []).filter((c) => !HASH_LIKE.test(c))
  }

  function pickAttributes(el) {
    const keep = ['data-testid', 'data-test', 'name', 'aria-label', 'aria-labelledby', 'title', 'href', 'src', 'value', 'type', 'alt', 'role']
    const out = {}
    for (const name of keep) {
      const v = el.getAttribute && el.getAttribute(name)
      if (v !== null && v !== undefined && v !== '') out[name] = v
    }
    // 其余稳定的 data-* 属性
    for (const attr of el.attributes || []) {
      if (attr.name.startsWith('data-') && attr.name !== 'data-testid' && attr.name !== 'data-test' && !HASH_LIKE.test(attr.value)) {
        out[attr.name] = attr.value
      }
    }
    return out
  }

  function accessibleName(el) {
    const labelled = el.getAttribute('aria-labelledby')
    if (labelled) {
      const ref = document.getElementById(labelled)
      if (ref) return ref.textContent.trim().slice(0, 80)
    }
    return (
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.getAttribute('alt') ||
      (el.labels && el.labels[0] ? el.labels[0].textContent.trim() : '') ||
      ''
    ).slice(0, 80)
  }

  function buildAncestry(el) {
    const chain = []
    let cur = el.parentElement
    let depth = 0
    while (cur && depth < 8) {
      chain.push({
        tag: cur.tagName.toLowerCase(),
        id: HASH_LIKE.test(cur.id || '') ? undefined : cur.id || undefined,
        attributes: pickAttributes(cur),
        classList: stableClasses(cur)
      })
      cur = cur.parentElement
      depth += 1
    }
    return chain
  }

  function signature(el) {
    return [el.tagName, stableClasses(el).slice(0, 2).join('.'), el.children.length].join('|')
  }

  // list-container 模式下：找直接子节点里结构相似的最大分组，作为行容器候选
  function analyzeRows(container) {
    const groups = new Map()
    for (const child of container.children) {
      const sig = signature(child)
      const list = groups.get(sig) || []
      list.push(child)
      groups.set(sig, list)
    }
    let best = { count: 0, tag: null, className: null }
    for (const [sig, list] of groups) {
      if (list.length > best.count) {
        best = {
          count: list.length,
          tag: list[0].tagName.toLowerCase(),
          className: stableClasses(list[0]).join(' ')
        }
      }
      void sig
    }
    return best
  }

  function descriptorOf(el) {
    return {
      tag: el.tagName.toLowerCase(),
      id: HASH_LIKE.test(el.id || '') ? undefined : el.id || undefined,
      role: el.getAttribute('role') || undefined,
      accessibleName: accessibleName(el) || undefined,
      attributes: pickAttributes(el),
      classList: stableClasses(el),
      textPreview: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
      outerHtmlPreview: el.outerHTML.replace(/\s+/g, ' ').slice(0, 300),
      ancestry: buildAncestry(el),
      rowStats: mode === 'list-container' ? analyzeRows(el) : undefined
    }
  }

  function ensureOverlay() {
    if (overlay) return overlay
    overlay = document.createElement('div')
    overlay.style.cssText =
      'position:fixed;pointer-events:none;z-index:2147483646;background:rgba(64,128,255,0.18);outline:2px solid #4080ff;outline-offset:-1px;border-radius:2px;transition:all 60ms ease;'
    document.documentElement.appendChild(overlay)
    return overlay
  }

  function positionOverlay(el) {
    const box = ensureOverlay()
    const rect = el.getBoundingClientRect()
    box.style.top = rect.top + 'px'
    box.style.left = rect.left + 'px'
    box.style.width = rect.width + 'px'
    box.style.height = rect.height + 'px'
    box.style.display = rect.width && rect.height ? 'block' : 'none'
  }

  let lastHover = null
  document.addEventListener(
    'mousemove',
    (event) => {
      if (mode === 'off') return
      const el = document.elementFromPoint(event.clientX, event.clientY)
      if (!el || el === overlay || el === document.documentElement || el === document.body) return
      lastHover = el
      positionOverlay(el)
    },
    true
  )

  window.addEventListener('scroll', () => {
    if (lastHover && mode !== 'off') positionOverlay(lastHover)
  }, true)
  window.addEventListener('resize', () => {
    if (lastHover && mode !== 'off') positionOverlay(lastHover)
  })

  function onPointerDown(event) {
    if (mode === 'off') return
    const el = event.target
    if (!el || el === overlay) return
    event.preventDefault()
    event.stopPropagation()
  }

  function onClick(event) {
    if (mode === 'off') return
    const el = event.target
    if (!el || el === overlay) return
    event.preventDefault()
    event.stopPropagation()

    const payload = { descriptor: descriptorOf(el), fieldId: pendingFieldId }
    if (!el.__pickflowElId) {
      elementSeq += 1
      el.__pickflowElId = String(elementSeq)
      elementRegistry.set(el.__pickflowElId, el)
    }
    payload.elementId = el.__pickflowElId
    Promise.resolve(window.__pickflowPick(payload)).catch(() => undefined)
  }

  document.addEventListener('mousedown', onPointerDown, true)
  document.addEventListener('click', onClick, true)

  // Node 侧通过 page.evaluate 调用的控制接口
  window.__pickflowSetMode = (nextMode, fieldId = null) => {
    mode = nextMode || 'off'
    pendingFieldId = fieldId
    if (mode === 'off' && overlay) overlay.style.display = 'none'
  }

  window.__pickflowGetMode = () => ({ mode, fieldId: pendingFieldId })

  // Node 侧凭 elementId 取回真实元素句柄（跨 frame 在各自 frame 内查找）
  window.__pickflowResolve = (id) => elementRegistry.get(id) || null
})()
