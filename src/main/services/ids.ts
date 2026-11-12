import { randomBytes, createHash } from 'node:crypto'

// 26 位时间排序 id，足够本地单机使用，避免引入额外依赖。
const ENCODING = '0123456789abcdefghijklmnopqrstuvwxyz'

export function ulid(): string {
  const time = Date.now()
  let timePart = ''
  let t = time
  for (let i = 0; i < 10; i++) {
    timePart = ENCODING[t % 36] + timePart
    t = Math.floor(t / 36)
  }
  const random = randomBytes(10)
  let randomPart = ''
  for (const byte of random) {
    randomPart += ENCODING[byte % 36]
  }
  return timePart + randomPart
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

export function nowIso(): string {
  return new Date().toISOString()
}
