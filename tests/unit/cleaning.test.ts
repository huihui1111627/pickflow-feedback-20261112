import { describe, expect, it } from 'vitest'
import { applyCleanings, buildDedupeKey, htmlDecode, toTypedValue } from '../../src/main/engine/cleaning.js'

describe('htmlDecode', () => {
  it('解码常见实体', () => {
    expect(htmlDecode('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;')).toBe(`a & b <c> "d" 'e'`)
  })
  it('未知实体原样保留', () => {
    expect(htmlDecode('&notanentity;')).toBe('&notanentity;')
  })
})

describe('toTypedValue', () => {
  it('数字：容忍千分位和货币符号', () => {
    expect(toTypedValue('¥1,234.56', 'number')).toBe(1234.56)
    expect(toTypedValue('abc', 'number')).toBeNull()
    expect(toTypedValue('', 'number')).toBeNull()
  })
  it('百分比转小数', () => {
    expect(toTypedValue('45%', 'number')).toBe(0.45)
  })
  it('布尔：中英文都认', () => {
    expect(toTypedValue('是', 'boolean')).toBe(true)
    expect(toTypedValue('no', 'boolean')).toBe(false)
    expect(toTypedValue('??', 'boolean')).toBeNull()
  })
  it('日期：输出 ISO', () => {
    const iso = toTypedValue('2026-01-15', 'date')
    expect(typeof iso).toBe('string')
    expect(String(iso)).toContain('2026-01-15')
    expect(toTypedValue('不是日期', 'date')).toBeNull()
  })
})

describe('applyCleanings', () => {
  it('按顺序执行多步操作', () => {
    const row = { f1: '  价格：¥1,299 元  ' }
    const out = applyCleanings(row, [
      { fieldId: 'f1', ops: [{ op: 'trim' }] },
      { fieldId: 'f1', ops: [{ op: 'regexExtract', pattern: '¥([\\d,]+)', group: 1 }] },
      { fieldId: 'f1', ops: [{ op: 'toType', target: 'number' }] }
    ])
    expect(out.f1).toBe(1299)
  })

  it('concat 可以引用其他字段并创建虚拟字段', () => {
    const row = { a: '张', b: '三丰' }
    const out = applyCleanings(row, [
      { fieldId: 'full', ops: [{ op: 'concat', sources: ['a', 'b'], separator: '' }] }
    ])
    expect(out.full).toBe('张三丰')
    expect(out.a).toBe('张')
  })

  it('split 取指定段', () => {
    const row = { addr: '浙江-杭州-西湖区' }
    const out = applyCleanings(row, [{ fieldId: 'city', ops: [{ op: 'split', source: 'addr', separator: '-', index: 1 }] }])
    expect(out.city).toBe('杭州')
  })

  it('mapEnum 命中映射，未命中用 fallback', () => {
    const row = { status: '洽谈中' }
    const out = applyCleanings(row, [
      { fieldId: 'status', ops: [{ op: 'mapEnum', mapping: { 已成交: 'done' }, fallback: 'other' }] }
    ])
    expect(out.status).toBe('other')
  })

  it('regexReplace 默认全局替换', () => {
    const row = { t: '2026年01月15日' }
    const out = applyCleanings(row, [
      { fieldId: 't', ops: [{ op: 'regexReplace', pattern: '[年月]', replacement: '-' }] },
      { fieldId: 't', ops: [{ op: 'regexReplace', pattern: '日', replacement: '' }] }
    ])
    expect(out.t).toBe('2026-01-15')
  })
})

describe('buildDedupeKey', () => {
  it('拼接指定字段', () => {
    expect(buildDedupeKey({ a: ' 1 ', b: 'x' }, ['a', 'b'])).toBe('a=1|b=x')
  })
  it('空数组返回空串（交给全字段哈希）', () => {
    expect(buildDedupeKey({ a: '1' }, [])).toBe('')
  })
})
