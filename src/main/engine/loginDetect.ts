import type { Page } from 'playwright'
import type { LoginDetectionSpec } from '../../shared/rule.types.js'
import { resolveFirstAvailable } from '../browser/locatorResolve.js'

// 登录过期检测：四个信号任一命中即判定过期。
// 在每次页面导航后调用，命中即暂停任务等用户重新登录。

export async function detectLoginExpired(page: Page, spec: LoginDetectionSpec | undefined): Promise<string | null> {
  if (!spec) return null

  if (spec.loginUrlPattern) {
    try {
      if (new RegExp(spec.loginUrlPattern).test(page.url())) {
        return `页面跳转到登录地址: ${page.url()}`
      }
    } catch {
      // 用户配的正则非法时忽略该信号
    }
  }

  if (spec.featureLocator) {
    const found = await resolveFirstAvailable(page, spec.featureLocator)
    if (found) return '页面出现登录过期特征元素'
  }

  if (spec.cookieName) {
    const cookies = await page.context().cookies()
    if (!cookies.some((c) => c.name === spec.cookieName)) {
      return `登录 Cookie 缺失: ${spec.cookieName}`
    }
  }

  return null
}

// HTTP 状态码信号在导航响应上检查，单独一个函数便于引擎在 goto 时调用
export function isLoginStatusCode(status: number, spec: LoginDetectionSpec | undefined): boolean {
  return spec?.statusCodes?.includes(status) ?? false
}
