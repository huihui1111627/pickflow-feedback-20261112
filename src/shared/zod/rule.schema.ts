import { z } from 'zod'
import { SCHEMA_VERSION } from '../rule.types'

// 规则快照的 zod 校验。加载历史版本时先过 schema，再按 schemaVersion 做迁移。

const candidateLocatorSchema = z.object({
  engine: z.enum(['role', 'testid', 'label', 'text', 'css', 'xpath']),
  value: z.string().min(1),
  options: z.object({ exact: z.boolean().optional(), attr: z.string().optional() }).optional(),
  score: z.number().optional()
})

const locatorSpecSchema = z.object({
  candidates: z.array(candidateLocatorSchema).min(1),
  framePath: z.lazy(() => z.array(frameRefSchema)).optional()
})

const frameRefSchema: z.ZodType = z.lazy(() =>
  z.object({
    iframeLocator: locatorSpecSchema,
    name: z.string().optional(),
    urlPattern: z.string().optional()
  })
)

const fieldSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['text', 'html', 'attr']),
  attr: z.string().optional(),
  locator: locatorSpecSchema,
  scope: z.enum(['list', 'detail']),
  required: z.boolean().optional(),
  dataType: z.enum(['string', 'number', 'boolean', 'date'])
})

const cleaningOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('trim') }),
  z.object({ op: z.literal('regexExtract'), pattern: z.string(), flags: z.string().optional(), group: z.number().int().nonnegative() }),
  z.object({ op: z.literal('regexReplace'), pattern: z.string(), flags: z.string().optional(), replacement: z.string() }),
  z.object({ op: z.literal('htmlDecode') }),
  z.object({
    op: z.literal('toType'),
    target: z.enum(['string', 'number', 'boolean', 'date']),
    dateFormat: z.string().optional()
  }),
  z.object({ op: z.literal('concat'), sources: z.array(z.string()).min(1), separator: z.string() }),
  z.object({ op: z.literal('split'), source: z.string(), separator: z.string(), index: z.union([z.number().int().nonnegative(), z.literal('all')]) }),
  z.object({ op: z.literal('mapEnum'), mapping: z.record(z.string()), fallback: z.string().optional() }),
  z.object({ op: z.literal('dedupe'), scope: z.enum(['field', 'composite']), fields: z.array(z.string()).optional() })
])

const paginationSchema = z.object({
  mode: z.enum(['none', 'click', 'url', 'form', 'scroll']),
  maxPages: z.number().int().positive(),
  click: z.object({ next: locatorSpecSchema }).optional(),
  url: z.object({ template: z.string(), startPage: z.number().int(), paramName: z.string().optional() }).optional(),
  form: z
    .object({
      form: locatorSpecSchema,
      submit: locatorSpecSchema,
      fills: z.array(z.object({ locator: locatorSpecSchema, value: z.string() }))
    })
    .optional(),
  scroll: z
    .object({
      container: locatorSpecSchema.optional(),
      maxScrolls: z.number().int().positive(),
      settleMs: z.number().int().nonnegative(),
      noNewRowsRounds: z.number().int().positive()
    })
    .optional()
})

const attachmentSchema = z.object({
  id: z.string().min(1),
  sourceFieldId: z.string().optional(),
  locator: locatorSpecSchema.optional(),
  attr: z.enum(['href', 'src']),
  allowedExtensions: z.array(z.string()).optional(),
  naming: z.string()
})

export const ruleSnapshotSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  startUrl: z.string().url(),
  rootFramePath: z.array(frameRefSchema).optional(),
  list: z.object({ container: locatorSpecSchema, row: locatorSpecSchema }),
  fields: z.array(fieldSchema),
  detail: z
    .object({
      linkLocator: locatorSpecSchema,
      openStrategy: z.enum(['new-tab', 'same-page']),
      fields: z.array(fieldSchema),
      framePath: z.array(frameRefSchema).optional()
    })
    .optional(),
  pagination: paginationSchema,
  cleaning: z.array(z.object({ fieldId: z.string(), ops: z.array(cleaningOpSchema) })),
  attachments: z.array(attachmentSchema),
  dedupeKey: z.array(z.string()),
  retry: z.object({
    maxAttempts: z.number().int().positive(),
    backoffBaseMs: z.number().int().nonnegative(),
    backoffMaxMs: z.number().int().nonnegative()
  }),
  throttle: z.object({ minIntervalMs: z.number().int().nonnegative(), jitterMs: z.number().int().nonnegative() }),
  login: z
    .object({
      statusCodes: z.array(z.number().int()).optional(),
      loginUrlPattern: z.string().optional(),
      featureLocator: locatorSpecSchema.optional(),
      cookieName: z.string().optional()
    })
    .optional(),
  schedule: z.object({ cron: z.string(), timezone: z.string(), enabled: z.boolean() }).optional()
})

export function parseRuleSnapshot(input: unknown): RuleSnapshotLike {
  return ruleSnapshotSchema.parse(input)
}

export type RuleSnapshotLike = z.infer<typeof ruleSnapshotSchema>
