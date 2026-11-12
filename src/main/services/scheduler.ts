import nodeCron from 'node-cron'
import { runRepo } from '../db/repositories/run.repo.js'
import { ruleRepo } from '../db/repositories/rule.repo.js'
import { runManager } from './runManager.js'

// 定时调度：每 30 秒扫描一次启用了 schedule 的任务，用 node-cron.parse 得到的
// 字段数组比对当前时间（按任务时区）。扫描式而非动态注册，应用重启后自动恢复，
// 改配置下个 tick 即生效。单实例只允许一个活跃 run，到点时有任务在跑就跳过。

const TICK_MS = 30_000
const LOCAL = 'local'

type ParsedFields = {
  second: number[]
  minute: number[]
  hour: number[]
  dayOfMonth: number[]
  month: number[]
  dayOfWeek: number[]
}

// 纯函数：cron 字段数组是否命中某时刻。
// 日/星期遵循标准 cron 语义：两者都受限（都不是 *）时取 OR，
// 任一方是 *（全集）时退化为 AND，否则 * 会让日限制失效。
export function cronFieldsMatch(
  parsed: Pick<ParsedFields, 'minute' | 'hour' | 'dayOfMonth' | 'month' | 'dayOfWeek'>,
  f: { minute: number; hour: number; dom: number; month: number; dow: number }
): boolean {
  const base =
    parsed.minute.includes(f.minute) &&
    parsed.hour.includes(f.hour) &&
    parsed.month.includes(f.month)
  if (!base) return false

  const domRestricted = parsed.dayOfMonth.length !== 31
  const dowRestricted = parsed.dayOfWeek.length !== 7
  if (domRestricted && dowRestricted) {
    return parsed.dayOfMonth.includes(f.dom) || parsed.dayOfWeek.includes(f.dow)
  }
  return parsed.dayOfMonth.includes(f.dom) && parsed.dayOfWeek.includes(f.dow)
}

interface DueEntry {
  taskId: string
  ruleId: string
  profileId: string | null
}

interface CronTimeFields {
  minute: number
  hour: number
  dom: number
  month: number
  dow: number
  minuteKey: number
}

// 取某时刻在指定时区下的 cron 字段。'local' 表示用运行机器的本地时区。
export function cronTimeFields(date: Date, timezone: string): CronTimeFields {
  const tz = timezone === LOCAL ? undefined : timezone
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false
  }).formatToParts(date)
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 'NaN')
  const minute = get('minute')
  const hour = get('hour') % 24
  const dom = get('day')
  const month = get('month')
  const year = get('year')
  // 时区下的星期：用该时区的日期分量重建一个 Date 再取 getDay
  const dow = new Date(year, month - 1, dom).getDay()
  const minuteKey = year * 100000000 + month * 1000000 + dom * 10000 + hour * 100 + minute
  return { minute, hour, dom, month, dow, minuteKey }
}

export class SchedulerService {
  private timer: NodeJS.Timeout | null = null
  // 同一分钟内同一任务只触发一次，避免 30s tick 在一分钟内跑两遍
  private firedThisMinute = new Map<string, number>()

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        console.error('[scheduler] tick 失败', err)
      })
    }, TICK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.firedThisMinute.clear()
  }

  validateCron(expr: string): boolean {
    return nodeCron.validate(expr)
  }

  // 取任务时区下指定时刻的各 cron 字段
  private nowFields(timezone: string): CronTimeFields {
    return cronTimeFields(new Date(), timezone)
  }

  private matches(parsed: ParsedFields, f: ReturnType<SchedulerService['nowFields']>): boolean {
    return cronFieldsMatch(parsed, f)
  }

  private collectDue(): DueEntry[] {
    const due: DueEntry[] = []
    const scheduled = runRepo.listScheduledTasks()

    for (const task of scheduled) {
      if (!nodeCron.validate(task.schedule.cron)) continue
      const parsed = nodeCron.parse(task.schedule.cron) as ParsedFields
      const fields = this.nowFields(task.schedule.timezone)
      if (this.firedThisMinute.get(task.id) === fields.minuteKey) continue
      if (!this.matches(parsed, fields)) continue

      this.firedThisMinute.set(task.id, fields.minuteKey)
      due.push({ taskId: task.id, ruleId: task.rule_id, profileId: task.profile_id })
    }

    // 清理跨分钟的旧键，防止 map 无限增长
    for (const [id, key] of this.firedThisMinute) {
      const task = scheduled.find((t) => t.id === id)
      if (!task || this.nowFields(task.schedule.timezone).minuteKey !== key) {
        this.firedThisMinute.delete(id)
      }
    }
    return due
  }

  private async tick(): Promise<void> {
    const due = this.collectDue()
    if (due.length === 0) return
    if (runManager.isBusy()) return // 单实例并发锁：有任务在跑整体跳过本轮

    for (const entry of due) {
      if (runManager.isBusy()) break
      try {
        // 始终绑定规则当前版本；规则升级产生新版本后，下一次定时自动用新版
        const rule = ruleRepo.get(entry.ruleId)
        if (!rule?.currentVersionId) continue
        await runManager.start({
          ruleVersionId: rule.currentVersionId,
          profileId: entry.profileId ?? undefined,
          trigger: 'schedule'
        })
      } catch (err) {
        console.error(`[scheduler] 任务 ${entry.taskId} 触发失败`, err)
      }
    }
  }
}

export const scheduler = new SchedulerService()
