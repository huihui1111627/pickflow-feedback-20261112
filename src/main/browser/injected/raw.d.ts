declare module '*?raw' {
  const content: string
  export default content
}

// picker.init.js 注入到每个 frame 后挂在 window 上的控制接口
interface Window {
  __pickflowInstalled?: boolean
  __pickflowPick?: (payload: unknown) => Promise<unknown>
  __pickflowSetMode?: (mode: string, fieldId?: string | null) => void
  __pickflowGetMode?: () => { mode: string; fieldId: string | null }
  __pickflowResolve?: (id: string) => Element | null
}
