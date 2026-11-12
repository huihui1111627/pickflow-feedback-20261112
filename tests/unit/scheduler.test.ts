import { describe, expect, it } from 'vitest'
import nodeCron from 'node-cron'
import { cronFieldsMatch, cronTimeFields } from '../../src/main/services/scheduler.js'

// 调度匹配纯函数：用 node-cron 官方 parse 的产物验证我们的命中判定，
// 重点覆盖分钟/小时、星期、以及 cron 的 日 OR 星期 语义。

const parse = (expr: string) =>
  nodeCron.parse(expr) as ReturnType<typeof nodeCron.parse> as {
    minute: number[]
    hour: number[]
    dayOfMonth: number[]
    month: number[]
    dayOfWeek: number[]
  }

describe('cronFieldsMatch', () => {
  it('每 5 分钟（*/5 * * * *）', () => {
    const p = parse('*/5 * * * *')
    expect(cronFieldsMatch(p, { minute: 0, hour: 9, dom: 12, month: 11, dow: 4 })).toBe(true)
    expect(cronFieldsMatch(p, { minute: 10, hour: 9, dom: 12, month: 11, dow: 4 })).toBe(true)
    expect(cronFieldsMatch(p, { minute: 7, hour: 9, dom: 12, month: 11, dow: 4 })).toBe(false)
  })

  it('工作日 9 点整（0 9 * * 1-5）', () => {
    const p = parse('0 9 * * 1-5')
    // 周四 9:00 命中
    expect(cronFieldsMatch(p, { minute: 0, hour: 9, dom: 12, month: 11, dow: 4 })).toBe(true)
    // 9:01 不命中
    expect(cronFieldsMatch(p, { minute: 1, hour: 9, dom: 12, month: 11, dow: 4 })).toBe(false)
    // 周六 9:00 不命中（dow=6 不在 1-5）
    expect(cronFieldsMatch(p, { minute: 0, hour: 9, dom: 14, month: 11, dow: 6 })).toBe(false)
  })

  it('日与星期是 OR 关系：每月1号 或 周一（0 10 1 * 1）', () => {
    const p = parse('0 10 1 * 1')
    // 周一但不是 1 号：靠星期命中
    expect(cronFieldsMatch(p, { minute: 0, hour: 10, dom: 9, month: 11, dow: 1 })).toBe(true)
    // 1 号但不是周一：靠日命中
    expect(cronFieldsMatch(p, { minute: 0, hour: 10, dom: 1, month: 11, dow: 5 })).toBe(true)
    // 既不是 1 号也不是周一：不命中
    expect(cronFieldsMatch(p, { minute: 0, hour: 10, dom: 3, month: 11, dow: 3 })).toBe(false)
    // 周六（dow=6）且不是 1 号，双方都受限、两个都不满足：不命中
    expect(cronFieldsMatch(p, { minute: 0, hour: 10, dom: 7, month: 11, dow: 6 })).toBe(false)
    // 时间不对也不命中
    expect(cronFieldsMatch(p, { minute: 30, hour: 10, dom: 1, month: 11, dow: 5 })).toBe(false)
  })

  it('月份过滤（0 0 1 1 * 只在1月）', () => {
    const p = parse('0 0 1 1 *')
    expect(cronFieldsMatch(p, { minute: 0, hour: 0, dom: 1, month: 1, dow: 3 })).toBe(true)
    expect(cronFieldsMatch(p, { minute: 0, hour: 0, dom: 1, month: 2, dow: 6 })).toBe(false)
  })
})

describe('node-cron 表达式校验', () => {
  it('合法与非法表达式', () => {
    expect(nodeCron.validate('*/30 * * * *')).toBe(true)
    expect(nodeCron.validate('0 9 * * 1-5')).toBe(true)
    expect(nodeCron.validate('not a cron')).toBe(false)
    expect(nodeCron.validate('99 * * * *')).toBe(false)
  })
})

describe('cronTimeFields 时区计算', () => {
  // 固定一个 UTC 时刻：2026-11-12T01:30:00Z
  const instant = new Date('2026-11-12T01:30:00Z')

  it('UTC 时区字段', () => {
    const f = cronTimeFields(instant, 'UTC')
    expect(f.minute).toBe(30)
    expect(f.hour).toBe(1)
    expect(f.dom).toBe(12)
    expect(f.month).toBe(11)
  })

  it('上海（UTC+8）跨小时，字段相应偏移', () => {
    const f = cronTimeFields(instant, 'Asia/Shanghai')
    expect(f.hour).toBe(9)
    expect(f.minute).toBe(30)
    expect(f.dom).toBe(12)
  })

  it('24 小时制：下午不会出现 >23 的小时', () => {
    const evening = new Date('2026-11-12T23:30:00Z') // 上海次日 07:30
    const f = cronTimeFields(evening, 'Asia/Shanghai')
    expect(f.hour).toBeLessThanOrEqual(23)
    expect(f.hour).toBe(7)
  })

  it('minuteKey 随分钟单调，可用于同分钟去重', () => {
    const a = cronTimeFields(new Date('2026-11-12T01:30:59Z'), 'UTC')
    const b = cronTimeFields(new Date('2026-11-12T01:31:00Z'), 'UTC')
    expect(b.minuteKey).toBeGreaterThan(a.minuteKey)
    // 同一分钟内不同秒，minuteKey 相同
    const a2 = cronTimeFields(new Date('2026-11-12T01:30:10Z'), 'UTC')
    expect(a2.minuteKey).toBe(a.minuteKey)
  })
})
