import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat.js'
import type { CleaningOp, DataType, FieldCleaning } from '../../shared/rule.types.js'

dayjs.extend(customParseFormat)

// 清洗管线：全部纯函数，不碰浏览器与数据库，单测直接覆盖。
// 管线按规则里的顺序逐条执行，每条读写同一个 row 记录，后面的 concat/split 可以引用前面算出的字段。

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'"
}

export function htmlDecode(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) {
      return String.fromCodePoint(parseInt(name.slice(2), 16))
    }
    if (name.startsWith('#')) {
      return String.fromCodePoint(parseInt(name.slice(1), 10))
    }
    return ENTITIES[name] ?? m
  })
}

export function toTypedValue(value: unknown, target: DataType, dateFormat?: string): unknown {
  if (value === null || value === undefined || value === '') return null
  const s = String(value).trim()
  switch (target) {
    case 'number': {
      // 容忍千分位、货币符号、空白，只保留数字、负号、小数点、百分号
      const cleaned = s.replace(/[^0-9.\-%]/g, '').replace(/%/g, '')
      if (cleaned === '' || cleaned === '-' || cleaned === '.') return null
      const n = Number(cleaned)
      if (Number.isNaN(n)) return null
      return s.includes('%') ? n / 100 : n
    }
    case 'boolean': {
      const lower = s.toLowerCase()
      if (['true', '1', 'yes', 'y', '是', '有'].includes(lower)) return true
      if (['false', '0', 'no', 'n', '否', '无'].includes(lower)) return false
      return null
    }
    case 'date': {
      const d = dateFormat ? dayjs(s, dateFormat) : dayjs(s)
      if (!d.isValid()) return null
      // 纯日期（无时间成分）保持 YYYY-MM-DD，避免时区换算把日期拨回前一天
      const hasTime = /[T ]\d{1,2}:\d{2}/.test(s)
      return hasTime ? d.toISOString() : d.format('YYYY-MM-DD')
    }
    case 'string':
    default:
      return s
  }
}

function asString(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value)
}

function applyOp(row: Record<string, unknown>, fieldId: string, op: CleaningOp): unknown {
  const current = row[fieldId]
  switch (op.op) {
    case 'trim':
      return asString(current).trim()
    case 'regexExtract': {
      const re = new RegExp(op.pattern, op.flags ?? '')
      const m = re.exec(asString(current))
      if (!m) return null
      return m[op.group] ?? m[0] ?? null
    }
    case 'regexReplace':
      return asString(current).replace(new RegExp(op.pattern, op.flags ?? 'g'), op.replacement)
    case 'htmlDecode':
      return htmlDecode(asString(current))
    case 'toType':
      return toTypedValue(current, op.target, op.dateFormat)
    case 'concat': {
      const parts = op.sources.map((id) => asString(row[id]))
      return parts.join(op.separator)
    }
    case 'split': {
      const parts = asString(row[op.source]).split(op.separator)
      if (op.index === 'all') return parts
      return parts[op.index] ?? null
    }
    case 'mapEnum': {
      const key = asString(current).trim()
      return op.mapping[key] ?? op.fallback ?? current
    }
    case 'dedupe':
      // 行级语义，由引擎在入库前处理，管线里原样透传
      return current
  }
}

// 按顺序应用全部清洗规则，返回新 row（不改入参）
export function applyCleanings(row: Record<string, unknown>, cleanings: FieldCleaning[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row }
  for (const cleaning of cleanings) {
    let value: unknown = out[cleaning.fieldId]
    for (const op of cleaning.ops) {
      // concat/split 从 row 读源字段，其余 op 作用于上一步的结果
      out[cleaning.fieldId] = value
      value = applyOp(out, cleaning.fieldId, op)
    }
    out[cleaning.fieldId] = value
  }
  return out
}

// 组合去重键的可读拼接，入库时存 dedupe_key 便于排查
export function buildDedupeKey(row: Record<string, unknown>, fields: string[]): string {
  if (fields.length === 0) return ''
  return fields.map((f) => `${f}=${asString(row[f]).trim()}`).join('|')
}
