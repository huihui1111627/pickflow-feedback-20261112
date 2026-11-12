import { describe, expect, it, beforeEach } from 'vitest'
import { getDb, closeDb } from '../../src/main/db/connection.js'
import { ruleRepo } from '../../src/main/db/repositories/rule.repo.js'
import type { RuleSnapshot } from '../../src/shared/rule.types.js'

// 规则版本：每次保存生成不可变新版本，历史版本快照不被后续修改影响。
// 这是"改规则不能影响正在跑的任务"的底层保证。

function baseSnapshot(startUrl: string): RuleSnapshot {
  const css = (value: string) => ({ candidates: [{ engine: 'css' as const, value }] })
  return {
    schemaVersion: 1,
    startUrl,
    list: { container: css('#list'), row: css('.row') },
    fields: [
      { id: 'title', name: '标题', kind: 'text', locator: css('.title'), scope: 'list', dataType: 'string' }
    ],
    pagination: { mode: 'none', maxPages: 1 },
    cleaning: [],
    attachments: [],
    dedupeKey: ['title'],
    retry: { maxAttempts: 3, backoffBaseMs: 100, backoffMaxMs: 1000 },
    throttle: { minIntervalMs: 0, jitterMs: 0 }
  }
}

describe('规则版本不可变', () => {
  beforeEach(() => {
    // 每个用例独立内存库，避免互相干扰
    closeDb()
    const db = getDb()
    db.exec('DELETE FROM rule_versions; DELETE FROM rules;')
  })

  it('更新生成新版本，旧版本快照保持原样', () => {
    const { ruleId, versionId: v1 } = ruleRepo.create('版本规则', undefined, baseSnapshot('https://a.test/v1'))

    const v1Snapshot = ruleRepo.getVersion(v1).snapshot
    expect(v1Snapshot.startUrl).toBe('https://a.test/v1')

    // 修改并保存 -> v2
    const changed = baseSnapshot('https://a.test/v2')
    const { versionId: v2 } = ruleRepo.update(ruleId, changed, '改了起始地址')

    expect(v2).not.toBe(v1)
    // v1 快照内容不变
    expect(ruleRepo.getVersion(v1).snapshot.startUrl).toBe('https://a.test/v1')
    // v2 是新内容
    expect(ruleRepo.getVersion(v2).snapshot.startUrl).toBe('https://a.test/v2')

    const all = ruleRepo.versions(ruleId)
    expect(all.map((x) => x.versionNo)).toEqual([2, 1])
    // 当前版本指针指向 v2
    expect(ruleRepo.get(ruleId)?.currentVersionId).toBe(v2)
  })

  it('版本号单调递增，checksum 随内容变化', () => {
    const { ruleId, versionId: v1 } = ruleRepo.create('c', undefined, baseSnapshot('https://x.test/1'))
    const v2 = ruleRepo.update(ruleId, baseSnapshot('https://x.test/2')).versionId
    const v3 = ruleRepo.update(ruleId, baseSnapshot('https://x.test/3')).versionId

    expect(ruleRepo.getVersion(v1).versionNo).toBe(1)
    expect(ruleRepo.getVersion(v2).versionNo).toBe(2)
    expect(ruleRepo.getVersion(v3).versionNo).toBe(3)

    const checksums = [v1, v2, v3].map((id) => ruleRepo.getVersion(id).checksum)
    expect(new Set(checksums).size).toBe(3)
  })
})
