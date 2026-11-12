import { BrowserWindow } from 'electron'
import type { CheckpointCursor, RunEvent } from '../../shared/run.types.js'
import type { StartRunRequest } from '../../shared/ipc.contract.js'
import { ruleRepo } from '../db/repositories/rule.repo.js'
import { runRepo } from '../db/repositories/run.repo.js'
import { Runner } from '../engine/runner.js'
import { playwrightManager } from '../browser/PlaywrightManager.js'
import { getSettings } from './settings.js'

// 运行编排：同一时间只允许一个活跃 run（单浏览器 profile 也起不了第二个）。
// stop 只是打标记，runner 在行间隙退出并保存检查点；resume 新建 run 挂 parent_run_id。

class RunManager {
  private activeRunner: Runner | null = null
  private activeRunId: string | null = null

  private emit = (event: RunEvent): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('run:event', event)
    }
  }

  isBusy(): boolean {
    return this.activeRunner !== null
  }

  async start(req: StartRunRequest): Promise<{ runId: string; taskId: string }> {
    if (this.activeRunner) throw new Error('已有任务在运行，请先停止')

    const version = ruleRepo.getVersion(req.ruleVersionId)
    const settings = getSettings()
    const taskId = runRepo.ensureTask(version.ruleId, req.ruleVersionId, req.profileId ?? null, {
      minIntervalMs: settings.defaultMinIntervalMs,
      jitterMs: settings.defaultJitterMs,
      maxAttempts: settings.defaultMaxAttempts
    })
    const runId = runRepo.createRun(taskId, req.ruleVersionId, req.trigger ?? 'manual', null)
    runRepo.setTaskStatus(taskId, 'running')

    await this.launch(runId, taskId, req.ruleVersionId, req.profileId ?? 'default', null)
    return { runId, taskId }
  }

  async stop(runId: string): Promise<void> {
    if (this.activeRunId !== runId || !this.activeRunner) return
    runRepo.updateStatus(runId, 'stopping')
    this.emit({ type: 'status', runId, status: 'stopping' })
    this.activeRunner.requestStop()
  }

  // 续跑：新建 run，从父 run 的检查点快进
  async resume(parentRunId: string): Promise<{ runId: string }> {
    if (this.activeRunner) throw new Error('已有任务在运行，请先停止')

    const parent = runRepo.getRun(parentRunId)
    const task = runRepo.getTask(parent.taskId)
    const cursor = runRepo.getCheckpoint(parentRunId)
    const runId = runRepo.createRun(parent.taskId, parent.ruleVersionId, 'resume', parentRunId)
    runRepo.setTaskStatus(parent.taskId, 'running')

    await this.launch(runId, parent.taskId, parent.ruleVersionId, task.profile_id ?? 'default', cursor)
    return { runId }
  }

  // 用户重新登录后点继续
  continueAfterLogin(runId: string): void {
    if (this.activeRunId === runId) this.activeRunner?.notifyLoginResolved()
  }

  private async launch(
    runId: string,
    taskId: string,
    ruleVersionId: string,
    profileId: string,
    resumeCursor: CheckpointCursor | null
  ): Promise<void> {
    const version = ruleRepo.getVersion(ruleVersionId)
    const managed = playwrightManager.isRunning()
      ? playwrightManager.active
      : await playwrightManager.start(profileId)

    const runner = new Runner({
      runId,
      taskId,
      ruleVersionId,
      snapshot: version.snapshot,
      context: managed.context,
      resumeCursor,
      emit: (event) => {
        this.emit(event)
        if (event.type === 'status') {
          runRepo.setTaskStatus(taskId, event.status)
          if (event.status === 'done' || event.status === 'stopped' || event.status === 'error') {
            this.activeRunner = null
            this.activeRunId = null
          }
        }
      }
    })
    this.activeRunner = runner
    this.activeRunId = runId

    // 不 await：run 在后台跑，事件通过 run:event 推给渲染进程
    void runner.run().catch(() => {
      this.activeRunner = null
      this.activeRunId = null
    })
  }
}

export const runManager = new RunManager()
