import type { BrowserContext, Frame, Page } from 'playwright'
import type { ElementDescriptor, FieldSpec, LocatorSpec, PickerMode } from '../../shared/rule.types'
import type { PickedElementPayload } from '../../shared/ipc.contract'
import pickerScript from './injected/picker.init.js?raw'
import { playwrightManager } from './PlaywrightManager.js'
import { generateGlobalSpec, generateRelativeSpec } from './selectorGen.js'
import { buildFramePath } from './framePath.js'

interface PickBindingPayload {
  descriptor: ElementDescriptor
  fieldId?: string
  elementId: string
}

// 一次点选会话的草稿状态：未保存也能反复预览
export interface PickerDraft {
  listContainer?: LocatorSpec
  row?: LocatorSpec
  rowElement?: { frame: Frame; elementId: string }
  fields: FieldSpec[]
  detailLink?: LocatorSpec
  paginationNext?: LocatorSpec
}

export class PickerSession {
  private mode: PickerMode = 'off'
  private fieldId: string | undefined
  readonly draft: PickerDraft = { fields: [] }
  private onPicked: ((payload: PickedElementPayload) => void) | null = null

  setPickedHandler(handler: (payload: PickedElementPayload) => void): void {
    this.onPicked = handler
  }

  async attach(context: BrowserContext): Promise<void> {
    await context.addInitScript(pickerScript)
    await context.exposeBinding('__pickflowPick', async (source, payload: PickBindingPayload) => {
      await this.handlePick(source.page, source.frame, payload)
    })
    // 已经打开的页面也要立即注入（addInitScript 只对之后的导航/新 frame 生效）
    for (const page of context.pages()) {
      await page.addScriptTag({ content: pickerScript }).catch(() => undefined)
    }
  }

  async setMode(mode: PickerMode, fieldId?: string): Promise<void> {
    this.mode = mode
    this.fieldId = fieldId
    const { context } = playwrightManager.active
    for (const page of context.pages()) {
      for (const frame of page.frames()) {
        await frame
          .evaluate(
            (arg: { m: PickerMode; id?: string }) => window.__pickflowSetMode?.(arg.m, arg.id ?? null),
            { m: mode, id: fieldId }
          )
          .catch(() => undefined)
      }
    }
  }

  getMode(): PickerMode {
    return this.mode
  }

  private async resolveElement(frame: Frame, elementId: string) {
    return frame.evaluateHandle((id: string) => window.__pickflowResolve?.(id) ?? null, elementId)
  }

  private async handlePick(_page: Page, frame: Frame, payload: PickBindingPayload): Promise<void> {
    const handle = await this.resolveElement(frame, payload.elementId)
    const element = handle.asElement()
    if (!element) return

    const framePath = await buildFramePath(frame)
    let spec: LocatorSpec
    let unique = false

    if (this.mode === 'field' && this.draft.rowElement) {
      const rowHandle = await this.resolveElement(this.draft.rowElement.frame, this.draft.rowElement.elementId)
      const row = rowHandle.asElement()
      if (row) {
        const generated = await generateRelativeSpec(row, element, payload.descriptor)
        spec = { candidates: generated.candidates, framePath }
        unique = generated.unique
      } else {
        const generated = await generateGlobalSpec(frame, element, payload.descriptor)
        spec = { candidates: generated.candidates, framePath }
        unique = generated.unique
      }
    } else {
      const generated = await generateGlobalSpec(frame, element, payload.descriptor)
      spec = { candidates: generated.candidates, framePath }
      unique = generated.unique
    }

    this.applyToDraft(spec, frame, payload)

    this.onPicked?.({
      descriptor: payload.descriptor,
      framePath,
      candidates: spec.candidates,
      unique
    })
  }

  private applyToDraft(spec: LocatorSpec, frame: Frame, payload: PickBindingPayload): void {
    switch (this.mode) {
      case 'list-container':
        this.draft.listContainer = spec
        // row 候选默认取容器启发式结果，用户可在 row 模式改点
        this.draft.row = spec
        break
      case 'row':
        this.draft.row = spec
        this.draft.rowElement = { frame, elementId: payload.elementId }
        break
      case 'field': {
        const existing = this.draft.fields.find((f) => f.id === this.fieldId)
        const field: FieldSpec = existing ?? {
          id: this.fieldId ?? `f_${this.draft.fields.length + 1}`,
          name: this.fieldId ?? `字段 ${this.draft.fields.length + 1}`,
          kind: 'text',
          locator: spec,
          scope: 'list',
          dataType: 'string'
        }
        field.locator = spec
        if (!existing) this.draft.fields.push(field)
        break
      }
      case 'detail-link':
        this.draft.detailLink = spec
        break
      case 'pagination':
        this.draft.paginationNext = spec
        break
      default:
        break
    }
  }
}
