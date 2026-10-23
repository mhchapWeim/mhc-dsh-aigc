/** One static literal, selected call, or script-review location. */
export interface OutboundFinding {
  kind: string
  value: string
  line: number
}

/** Summary of the static inventory; JSON on disk carries full findings and coverage limits. */
export interface OutboundAuditReport {
  status: string
  pendingFileCount: number
  source: { fileCount: number; sha256: string; commit: string; dirty: boolean }
}

/** Inspect JS/TS AST nodes without exposing URL credentials or request contents. */
export function inspectOutbound(text: string, file: string): OutboundFinding[]

/** Write reports and reject unreviewed source/dependency changes when enforcement is enabled. */
export function auditOutbound(options: {
  root?: string
  output: string
  artifacts?: string[]
  enforce?: boolean
}): OutboundAuditReport
