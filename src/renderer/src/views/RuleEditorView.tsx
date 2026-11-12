import { useEffect, useRef, useState } from 'react'
import type {
  AttachmentSpec,
  CleaningOp,
  FieldCleaning,
  FieldSpec,
  LocatorSpec,
  PaginationSpec,
  PickerMode,
  RuleSnapshot
} from '@shared/rule.types'
import { SCHEMA_VERSION } from '@shared/rule.types'
import type { PreviewRow } from '@shared/ipc.contract'

interface Props {
  ruleId: string | null
  onSaved: () => void
}

const DEFAULT_PAGINATION: PaginationSpec = { mode: 'none', maxPages: 10 }

export default function RuleEditorView({ ruleId, onSaved }: Props) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [startUrl, setStartUrl] = useState('')
  const [listContainer, setListContainer] = useState<LocatorSpec | undefined>()
  const [row, setRow] = useState<LocatorSpec | undefined>()
  const [fields, setFields] = useState<FieldSpec[]>([])
  const [detailEnabled, setDetailEnabled] = useState(false)
  const [detailLink, setDetailLink] = useState<LocatorSpec | undefined>()
  const [pagination, setPagination] = useState<PaginationSpec>(DEFAULT_PAGINATION)
  const [cleaning, setCleaning] = useState<FieldCleaning[]>([])
  const [attachments, setAttachments] = useState<AttachmentSpec[]>([])
  const [dedupeKey, setDedupeKey] = useState<string[]>([])
  const [retry, setRetry] = useState({ maxAttempts: 3, backoffBaseMs: 1000, backoffMaxMs: 10000 })
  const [throttle, setThrottle] = useState({ minIntervalMs: 800, jitterMs: 400 })
  const [loginUrlPattern, setLoginUrlPattern] = useState('')
  const [loginCookieName, setLoginCookieName] = useState('')

  const [pickerOn, setPickerOn] = useState(false)
  const [mode, setMode] = useState<PickerMode>('off')
  const [activeFieldId, setActiveFieldId] = useState<string | undefined>()
  const activeAttachmentId = useRef<string | undefined>()
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([])
  const [message, setMessage] = useState('')

  // 用 ref 让 picked 回调拿到最新的 mode / activeFieldId，避免闭包过期
  const modeRef = useRef(mode)
  modeRef.current = mode
  const activeFieldRef = useRef(activeFieldId)
  activeFieldRef.current = activeFieldId

  // 加载已有规则的最新版本
  useEffect(() => {
    if (!ruleId) return
    void (async () => {
      const summary = await window.api.rule.get(ruleId)
      if (!summary?.currentVersionId) return
      const version = await window.api.rule.getVersion(summary.currentVersionId)
      const s = version.snapshot
      setName(summary.name)
      setDescription(summary.description ?? '')
      setStartUrl(s.startUrl)
      setListContainer(s.list.container)
      setRow(s.list.row)
      setFields(s.fields)
      setDetailEnabled(!!s.detail)
      setDetailLink(s.detail?.linkLocator)
      setPagination(s.pagination)
      setCleaning(s.cleaning)
      setAttachments(s.attachments ?? [])
      setDedupeKey(s.dedupeKey)
      setRetry(s.retry)
      setThrottle(s.throttle)
      setLoginUrlPattern(s.login?.loginUrlPattern ?? '')
      setLoginCookieName(s.login?.cookieName ?? '')
    })()
  }, [ruleId])

  // 点选事件：按当前模式把定位器写回对应状态
  useEffect(() => {
    return window.api.picker.onPicked((payload) => {
      const spec: LocatorSpec = { candidates: payload.candidates, framePath: payload.framePath as LocatorSpec['framePath'] }
      const m = modeRef.current
      if (m === 'list-container') {
        setListContainer(spec)
        setRow((prev) => prev ?? spec)
      } else if (m === 'row') {
        setRow(spec)
      } else if (m === 'field') {
        const fid = activeFieldRef.current
        if (fid) setFields((prev) => prev.map((f) => (f.id === fid ? { ...f, locator: spec } : f)))
      } else if (m === 'detail-link') {
        setDetailLink(spec)
      } else if (m === 'pagination') {
        setPagination((prev) => ({ ...prev, mode: 'click', click: { next: spec } }))
      } else if (m === 'attachment') {
        const aid = activeAttachmentId.current
        if (aid) setAttachments((prev) => prev.map((a) => (a.id === aid ? { ...a, locator: spec } : a)))
      }
      setMessage(`已捕获元素（${payload.unique ? '唯一定位' : '定位不唯一，建议重选'}）`)
    })
  }, [])

  const enterMode = async (m: PickerMode, fieldId?: string) => {
    setMode(m)
    setActiveFieldId(fieldId)
    await window.api.picker.setMode(m, fieldId)
  }

  const openBrowser = async () => {
    await window.api.picker.start(startUrl || undefined)
    setPickerOn(true)
    setMessage('浏览器已打开，在页面上点选元素；登录态会保存在本机')
  }

  const buildSnapshot = (): RuleSnapshot => {
    if (!listContainer || !row) throw new Error('请先点选列表容器和行')
    return {
      schemaVersion: SCHEMA_VERSION,
      startUrl,
      list: { container: listContainer, row },
      fields,
      detail:
        detailEnabled && detailLink
          ? { linkLocator: detailLink, openStrategy: 'new-tab', fields: fields.filter((f) => f.scope === 'detail') }
          : undefined,
      pagination,
      cleaning,
      attachments,
      dedupeKey,
      retry,
      throttle,
      login:
        loginUrlPattern || loginCookieName
          ? { loginUrlPattern: loginUrlPattern || undefined, cookieName: loginCookieName || undefined }
          : undefined
    }
  }

  const doPreview = async () => {
    setMessage('')
    try {
      const snapshot = buildSnapshot()
      const result = await window.api.picker.preview({ snapshot, cleaning })
      setPreviewRows(result.rows)
      setMessage(result.rows.length === 0 ? '没有匹配到行，检查容器/行选择器' : `预览到 ${result.rows.length} 行`)
    } catch (e) {
      setMessage(`预览失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const save = async () => {
    setMessage('')
    try {
      if (!name.trim()) throw new Error('请填写规则名称')
      const snapshot = buildSnapshot()
      if (ruleId) {
        await window.api.rule.update({ ruleId, snapshot, changeNote: '编辑器保存' })
      } else {
        await window.api.rule.create({ name: name.trim(), description: description || undefined, snapshot })
      }
      onSaved()
    } catch (e) {
      setMessage(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const addField = async (scope: 'list' | 'detail') => {
    const id = `f_${fields.length + 1}_${Math.floor(Math.random() * 1000)}`
    const field: FieldSpec = {
      id,
      name: scope === 'list' ? `字段${fields.filter((f) => f.scope === 'list').length + 1}` : `详情字段${fields.filter((f) => f.scope === 'detail').length + 1}`,
      kind: 'text',
      // 占位候选，点选后会被替换；保存前必须有真实定位器
      locator: { candidates: [{ engine: 'css', value: 'body' }] },
      scope,
      dataType: 'string'
    }
    setFields((prev) => [...prev, field])
    await enterMode('field', id)
  }

  const updateField = (id: string, patch: Partial<FieldSpec>) => {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)))
  }

  const addAttachment = () => {
    const id = `att_${attachments.length + 1}_${Math.floor(Math.random() * 1000)}`
    const spec: AttachmentSpec = {
      id,
      // 默认走元素定位；切到字段模式时由 UI 清掉 locator、填 sourceFieldId
      locator: { candidates: [{ engine: 'css', value: 'body' }] },
      attr: 'href',
      naming: '{rowIndex}-{filename}'
    }
    setAttachments((prev) => [...prev, spec])
  }

  const updateAttachment = (id: string, patch: Partial<AttachmentSpec>) => {
    setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)))
  }

  const pickAttachment = async (id: string) => {
    activeAttachmentId.current = id
    await enterMode('attachment')
  }

  const locatorSummary = (spec?: LocatorSpec): string =>
    spec ? `${spec.candidates[0]?.engine ?? '?'}: ${spec.candidates[0]?.value?.slice(0, 60) ?? ''}` : '未设置'

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>{ruleId ? '编辑规则' : '新建规则'}</h2>
      {message && <p className="muted">{message}</p>}

      <div className="card">
        <h3>基本信息</h3>
        <div className="row">
          <input style={{ width: 200 }} placeholder="规则名称" value={name} onChange={(e) => setName(e.target.value)} />
          <input style={{ width: 240 }} placeholder="描述（可选）" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="row">
          <input
            style={{ flex: 1, minWidth: 320 }}
            placeholder="起始网址 https://…"
            value={startUrl}
            onChange={(e) => setStartUrl(e.target.value)}
          />
          <button className="primary" onClick={() => void openBrowser()}>
            {pickerOn ? '重新打开浏览器' : '打开浏览器'}
          </button>
          {pickerOn && (
            <button onClick={() => void window.api.picker.navigate(startUrl)} disabled={!startUrl}>
              跳到起始页
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <h3>列表结构（在浏览器页面上点选）</h3>
        <div className="row">
          <button disabled={!pickerOn} onClick={() => void enterMode('list-container')}>
            ① 点选列表容器
          </button>
          <span className="mono muted">{locatorSummary(listContainer)}</span>
        </div>
        <div className="row">
          <button disabled={!pickerOn} onClick={() => void enterMode('row')}>
            ② 点选其中一行
          </button>
          <span className="mono muted">{locatorSummary(row)}</span>
        </div>
        {mode !== 'off' && <p className="muted">当前点选模式：{mode}，到浏览器里点击目标元素；按 Esc 或再点按钮退出。</p>}
        <button disabled={!pickerOn || mode === 'off'} onClick={() => void enterMode('off')}>
          退出点选
        </button>
      </div>

      <div className="card">
        <h3>字段</h3>
        <div className="row">
          <button disabled={!pickerOn} onClick={() => void addField('list')}>
            + 列表字段
          </button>
          <button disabled={!pickerOn || !detailEnabled} onClick={() => void addField('detail')}>
            + 详情页字段
          </button>
          <span className="muted">加字段后自动进入点选模式，到页面点一下目标元素</span>
        </div>
        <table className="grid">
          <thead>
            <tr>
              <th>名称</th>
              <th>位置</th>
              <th>取值</th>
              <th>类型</th>
              <th>必填</th>
              <th>定位器</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.id}>
                <td>
                  <input value={f.name} onChange={(e) => updateField(f.id, { name: e.target.value })} style={{ width: 110 }} />
                </td>
                <td>
                  <select value={f.scope} onChange={(e) => updateField(f.id, { scope: e.target.value as FieldSpec['scope'] })}>
                    <option value="list">列表</option>
                    <option value="detail">详情</option>
                  </select>
                </td>
                <td>
                  <select
                    value={f.kind}
                    onChange={(e) => updateField(f.id, { kind: e.target.value as FieldSpec['kind'] })}
                  >
                    <option value="text">文本</option>
                    <option value="html">HTML</option>
                    <option value="attr">属性</option>
                  </select>
                  {f.kind === 'attr' && (
                    <input
                      style={{ width: 70, marginLeft: 4 }}
                      placeholder="href"
                      value={f.attr ?? ''}
                      onChange={(e) => updateField(f.id, { attr: e.target.value })}
                    />
                  )}
                </td>
                <td>
                  <select
                    value={f.dataType}
                    onChange={(e) => updateField(f.id, { dataType: e.target.value as FieldSpec['dataType'] })}
                  >
                    <option value="string">字符串</option>
                    <option value="number">数字</option>
                    <option value="boolean">布尔</option>
                    <option value="date">日期</option>
                  </select>
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={!!f.required}
                    onChange={(e) => updateField(f.id, { required: e.target.checked })}
                  />
                </td>
                <td>
                  <button disabled={!pickerOn} onClick={() => void enterMode('field', f.id)}>
                    重选
                  </button>
                  <div className="mono muted">{locatorSummary(f.locator)}</div>
                </td>
                <td>
                  <button className="danger" onClick={() => setFields((prev) => prev.filter((x) => x.id !== f.id))}>
                    删
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>详情页</h3>
        <div className="row">
          <label>
            <input type="checkbox" checked={detailEnabled} onChange={(e) => setDetailEnabled(e.target.checked)} /> 启用
          </label>
          <button disabled={!pickerOn || !detailEnabled} onClick={() => void enterMode('detail-link')}>
            点选行内详情链接
          </button>
          <span className="mono muted">{locatorSummary(detailLink)}</span>
        </div>
        {detailEnabled && <p className="muted">详情字段：在浏览器里手动打开一个详情页，然后「+ 详情页字段」逐个点选。</p>}
      </div>

      <div className="card">
        <h3>附件下载</h3>
        <div className="row">
          <button onClick={addAttachment}>+ 加附件规则</button>
          <span className="muted">元素定位适合下载按钮；URL 字段适合已抽出来的直链</span>
        </div>
        {attachments.length > 0 && (
          <table className="grid">
            <thead>
              <tr>
                <th>来源方式</th>
                <th>取值</th>
                <th>属性</th>
                <th>允许扩展名</th>
                <th>命名模板</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {attachments.map((a) => {
                const useField = !!a.sourceFieldId
                return (
                  <tr key={a.id}>
                    <td>
                      <select
                        value={useField ? 'field' : 'locator'}
                        onChange={(e) =>
                          updateAttachment(a.id, e.target.value === 'field'
                            ? { sourceFieldId: fields[0]?.id ?? '', locator: undefined }
                            : { sourceFieldId: undefined, locator: { candidates: [{ engine: 'css', value: 'body' }] } })
                        }
                      >
                        <option value="locator">元素定位</option>
                        <option value="field">URL 字段</option>
                      </select>
                    </td>
                    <td>
                      {useField ? (
                        <select
                          value={a.sourceFieldId}
                          onChange={(e) => updateAttachment(a.id, { sourceFieldId: e.target.value })}
                        >
                          {fields.map((f) => (
                            <option key={f.id} value={f.id}>{f.name}</option>
                          ))}
                        </select>
                      ) : (
                        <>
                          <button disabled={!pickerOn} onClick={() => void pickAttachment(a.id)}>点选下载元素</button>
                          <div className="mono muted">{locatorSummary(a.locator)}</div>
                        </>
                      )}
                    </td>
                    <td>
                      <select value={a.attr} onChange={(e) => updateAttachment(a.id, { attr: e.target.value as 'href' | 'src' })}>
                        <option value="href">href</option>
                        <option value="src">src</option>
                      </select>
                    </td>
                    <td>
                      <input
                        style={{ width: 110 }}
                        placeholder="pdf,docx（留空全收）"
                        value={(a.allowedExtensions ?? []).join(',')}
                        onChange={(e) =>
                          updateAttachment(a.id, {
                            allowedExtensions: e.target.value.split(',').map((s) => s.trim().replace('.', '')).filter(Boolean)
                          })
                        }
                      />
                    </td>
                    <td>
                      <input
                        style={{ width: 180 }}
                        value={a.naming}
                        onChange={(e) => updateAttachment(a.id, { naming: e.target.value })}
                      />
                    </td>
                    <td>
                      <button className="danger" onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}>
                        删
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>翻页 / 加载</h3>
        <div className="row">
          <select
            value={pagination.mode}
            onChange={(e) => setPagination({ ...pagination, mode: e.target.value as PaginationSpec['mode'] })}
          >
            <option value="none">单页</option>
            <option value="click">点击下一页</option>
            <option value="url">URL 页码</option>
            <option value="scroll">滚动加载</option>
          </select>
          {pagination.mode !== 'none' && pagination.mode !== 'scroll' && (
            <label>
              最大页数
              <input
                type="number"
                style={{ width: 70, marginLeft: 4 }}
                value={pagination.maxPages}
                onChange={(e) => setPagination({ ...pagination, maxPages: Number(e.target.value) || 1 })}
              />
            </label>
          )}
          {pagination.mode === 'click' && (
            <>
              <button disabled={!pickerOn} onClick={() => void enterMode('pagination')}>
                点选「下一页」按钮
              </button>
              <span className="mono muted">{locatorSummary(pagination.click?.next)}</span>
            </>
          )}
          {pagination.mode === 'url' && (
            <input
              style={{ flex: 1, minWidth: 280 }}
              placeholder="URL 模板，用 {page} 表示页码，如 https://x.com/list?page={page}"
              value={pagination.url?.template ?? ''}
              onChange={(e) =>
                setPagination({ ...pagination, url: { template: e.target.value, startPage: pagination.url?.startPage ?? 1 } })
              }
            />
          )}
          {pagination.mode === 'scroll' && (
            <>
              <input
                style={{ flex: 1, minWidth: 240 }}
                placeholder="滚动容器 CSS 选择器（内部 overflow 列表才填，留空滚整窗），如 #scroll-list"
                value={pagination.scroll?.container?.candidates[0]?.value ?? ''}
                onChange={(e) =>
                  setPagination({
                    ...pagination,
                    scroll: {
                      container: e.target.value.trim()
                        ? { candidates: [{ engine: 'css', value: e.target.value.trim() }] }
                        : undefined,
                      maxScrolls: pagination.scroll?.maxScrolls ?? 50,
                      settleMs: pagination.scroll?.settleMs ?? 1200,
                      noNewRowsRounds: pagination.scroll?.noNewRowsRounds ?? 3
                    }
                  })
                }
              />
              <label>
                最多滚动
                <input
                  type="number"
                  style={{ width: 60, margin: '0 4px' }}
                  value={pagination.scroll?.maxScrolls ?? 50}
                  onChange={(e) =>
                    setPagination({
                      ...pagination,
                      scroll: {
                        container: pagination.scroll?.container,
                        maxScrolls: Number(e.target.value) || 50,
                        settleMs: pagination.scroll?.settleMs ?? 1200,
                        noNewRowsRounds: pagination.scroll?.noNewRowsRounds ?? 3
                      }
                    })
                  }
                />
                次
              </label>
              <label>
                每次等待
                <input
                  type="number"
                  style={{ width: 70, margin: '0 4px' }}
                  value={pagination.scroll?.settleMs ?? 1200}
                  onChange={(e) =>
                    setPagination({
                      ...pagination,
                      scroll: {
                        container: pagination.scroll?.container,
                        maxScrolls: pagination.scroll?.maxScrolls ?? 50,
                        settleMs: Number(e.target.value) || 1200,
                        noNewRowsRounds: pagination.scroll?.noNewRowsRounds ?? 3
                      }
                    })
                  }
                />
                毫秒
              </label>
            </>
          )}
        </div>
      </div>

      <CleaningEditor cleaning={cleaning} fields={fields} onChange={setCleaning} />

      <div className="card">
        <h3>去重键（组合字段唯一标识一行，留空则全字段哈希）</h3>
        <div className="row">
          {[...fields.map((f) => f.id), ...cleaning.map((c) => c.fieldId)].map((fid) => (
            <label key={fid} style={{ marginRight: 12 }}>
              <input
                type="checkbox"
                checked={dedupeKey.includes(fid)}
                onChange={(e) =>
                  setDedupeKey((prev) => (e.target.checked ? [...prev, fid] : prev.filter((x) => x !== fid)))
                }
              />
              {fields.find((f) => f.id === fid)?.name ?? fid}
            </label>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>运行参数</h3>
        <div className="row">
          <label>
            间隔(毫秒)
            <input
              type="number"
              style={{ width: 80, margin: '0 8px 0 4px' }}
              value={throttle.minIntervalMs}
              onChange={(e) => setThrottle({ ...throttle, minIntervalMs: Number(e.target.value) || 0 })}
            />
          </label>
          <label>
            重试次数
            <input
              type="number"
              style={{ width: 60, margin: '0 8px 0 4px' }}
              value={retry.maxAttempts}
              onChange={(e) => setRetry({ ...retry, maxAttempts: Number(e.target.value) || 1 })}
            />
          </label>
        </div>
        <div className="row">
          <input
            style={{ width: 260 }}
            placeholder="登录页 URL 特征（正则，可选）"
            value={loginUrlPattern}
            onChange={(e) => setLoginUrlPattern(e.target.value)}
          />
          <input
            style={{ width: 200 }}
            placeholder="登录 Cookie 名（可选）"
            value={loginCookieName}
            onChange={(e) => setLoginCookieName(e.target.value)}
          />
          <span className="muted">命中任一特征 → 任务暂停等你重新登录</span>
        </div>
      </div>

      <div className="card">
        <div className="row">
          <button className="primary" disabled={!pickerOn} onClick={() => void doPreview()}>
            预览提取结果
          </button>
          <button className="primary" onClick={() => void save()}>
            保存规则
          </button>
        </div>
        {previewRows.length > 0 && (
          <table className="grid" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>#</th>
                {Object.keys(previewRows[0].data).map((k) => (
                  <th key={k}>{fields.find((f) => f.id === k)?.name ?? k}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {previewRows.map((r) => (
                <tr key={r.index}>
                  <td className="muted">{r.index + 1}</td>
                  {Object.values(r.data).map((v, i) => (
                    <td key={i}>{v ?? <span className="muted">空</span>}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ---- 清洗规则编辑器 ----

const OP_LABELS: Record<CleaningOp['op'], string> = {
  trim: '去空白',
  regexExtract: '正则提取',
  regexReplace: '正则替换',
  htmlDecode: 'HTML 解码',
  toType: '类型转换',
  concat: '拼接组合',
  split: '拆分取值',
  mapEnum: '枚举映射',
  dedupe: '去重标记'
}

function CleaningEditor({
  cleaning,
  fields,
  onChange
}: {
  cleaning: FieldCleaning[]
  fields: FieldSpec[]
  onChange: (next: FieldCleaning[]) => void
}) {
  const update = (index: number, patch: Partial<FieldCleaning>) => {
    onChange(cleaning.map((c, i) => (i === index ? { ...c, ...patch } : c)))
  }

  const addRule = () => {
    const firstField = fields[0]?.id ?? ''
    onChange([...cleaning, { fieldId: firstField, ops: [{ op: 'trim' }] }])
  }

  return (
    <div className="card">
      <h3>字段清洗 / 组合</h3>
      {cleaning.map((rule, i) => (
        <div className="field-ops" key={i}>
          <div className="row">
            <span className="muted">作用于</span>
            <input
              list="cleaning-field-ids"
              value={rule.fieldId}
              onChange={(e) => update(i, { fieldId: e.target.value })}
              style={{ width: 140 }}
            />
            <datalist id="cleaning-field-ids">
              {fields.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </datalist>
            <span className="muted">填新 id 即创建组合字段</span>
            <button className="danger" onClick={() => onChange(cleaning.filter((_, x) => x !== i))}>
              删除规则
            </button>
          </div>
          {rule.ops.map((op, j) => (
            <OpRow
              key={j}
              op={op}
              onChange={(next) => update(i, { ops: rule.ops.map((o, x) => (x === j ? next : o)) })}
              onRemove={() => update(i, { ops: rule.ops.filter((_, x) => x !== j) })}
            />
          ))}
          <button
            onClick={() => update(i, { ops: [...rule.ops, { op: 'trim' }] })}
            style={{ marginTop: 4 }}
          >
            + 加一步
          </button>
        </div>
      ))}
      <button onClick={addRule}>+ 加清洗规则</button>
    </div>
  )
}

function OpRow({ op, onChange, onRemove }: { op: CleaningOp; onChange: (op: CleaningOp) => void; onRemove: () => void }) {
  const setType = (type: CleaningOp['op']) => {
    switch (type) {
      case 'trim': onChange({ op: 'trim' }); break
      case 'regexExtract': onChange({ op: 'regexExtract', pattern: '', group: 0 }); break
      case 'regexReplace': onChange({ op: 'regexReplace', pattern: '', replacement: '' }); break
      case 'htmlDecode': onChange({ op: 'htmlDecode' }); break
      case 'toType': onChange({ op: 'toType', target: 'string' }); break
      case 'concat': onChange({ op: 'concat', sources: [], separator: ' ' }); break
      case 'split': onChange({ op: 'split', source: '', separator: ',', index: 0 }); break
      case 'mapEnum': onChange({ op: 'mapEnum', mapping: {} }); break
      case 'dedupe': onChange({ op: 'dedupe', scope: 'field' }); break
    }
  }

  return (
    <div className="row" style={{ marginBottom: 4 }}>
      <select value={op.op} onChange={(e) => setType(e.target.value as CleaningOp['op'])}>
        {(Object.keys(OP_LABELS) as CleaningOp['op'][]).map((k) => (
          <option key={k} value={k}>
            {OP_LABELS[k]}
          </option>
        ))}
      </select>
      {op.op === 'regexExtract' && (
        <>
          <input placeholder="正则" value={op.pattern} onChange={(e) => onChange({ ...op, pattern: e.target.value })} />
          <input
            style={{ width: 50 }}
            placeholder="组"
            type="number"
            value={op.group}
            onChange={(e) => onChange({ ...op, group: Number(e.target.value) || 0 })}
          />
        </>
      )}
      {op.op === 'regexReplace' && (
        <>
          <input placeholder="正则" value={op.pattern} onChange={(e) => onChange({ ...op, pattern: e.target.value })} />
          <input
            placeholder="替换为"
            value={op.replacement}
            onChange={(e) => onChange({ ...op, replacement: e.target.value })}
          />
        </>
      )}
      {op.op === 'toType' && (
        <>
          <select value={op.target} onChange={(e) => onChange({ ...op, target: e.target.value as 'string' | 'number' | 'boolean' | 'date' })}>
            <option value="string">字符串</option>
            <option value="number">数字</option>
            <option value="boolean">布尔</option>
            <option value="date">日期</option>
          </select>
          {op.target === 'date' && (
            <input
              placeholder="格式，如 YYYY-MM-DD"
              value={op.dateFormat ?? ''}
              onChange={(e) => onChange({ ...op, dateFormat: e.target.value })}
            />
          )}
        </>
      )}
      {op.op === 'concat' && (
        <>
          <input
            placeholder="源字段 id，逗号分隔"
            value={op.sources.join(',')}
            onChange={(e) => onChange({ ...op, sources: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
          />
          <input
            style={{ width: 60 }}
            placeholder="连接符"
            value={op.separator}
            onChange={(e) => onChange({ ...op, separator: e.target.value })}
          />
        </>
      )}
      {op.op === 'split' && (
        <>
          <input placeholder="源字段 id" value={op.source} onChange={(e) => onChange({ ...op, source: e.target.value })} />
          <input
            style={{ width: 60 }}
            placeholder="分隔符"
            value={op.separator}
            onChange={(e) => onChange({ ...op, separator: e.target.value })}
          />
          <input
            style={{ width: 60 }}
            placeholder="序号"
            type="number"
            value={op.index === 'all' ? 0 : op.index}
            onChange={(e) => onChange({ ...op, index: Number(e.target.value) || 0 })}
          />
        </>
      )}
      {op.op === 'mapEnum' && (
        <input
          style={{ width: 320 }}
          placeholder="映射，如 已成交=done,洽谈中=talking"
          value={Object.entries(op.mapping)
            .map(([k, v]) => `${k}=${v}`)
            .join(',')}
          onChange={(e) => {
            const mapping: Record<string, string> = {}
            for (const pair of e.target.value.split(',')) {
              const [k, v] = pair.split('=')
              if (k && v !== undefined) mapping[k.trim()] = v.trim()
            }
            onChange({ ...op, mapping })
          }}
        />
      )}
      <button className="danger" onClick={onRemove}>
        ✕
      </button>
    </div>
  )
}
