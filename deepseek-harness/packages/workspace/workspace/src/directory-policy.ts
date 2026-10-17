/** Directory selection policy shared by workspace registration and session activation. */
import { realpath, mkdir } from 'node:fs/promises'
import { relative, isAbsolute, sep, dirname } from 'node:path'
import { fullyQualifiedWorkspacePath } from './paths.ts'

/** Optional deployment directory restriction; both lexical and physical paths must stay inside it. */
export class WorkspaceDirectoryPolicy {
  /** @param root - Fully qualified allowed root, absent for an unrestricted deployment. */
  constructor(readonly root?: string) {
    if (root !== undefined && !fullyQualifiedWorkspacePath(root)) throw new Error('workspace allowedRoot must be fully qualified')
  }

  /** @param path - Workspace path. @returns Whether its normalized spelling is within the configured root. */
  includes(path: string): boolean {
    if (this.root === undefined) return true
    if (!fullyQualifiedWorkspacePath(path)) return false
    const suffix = relative(this.root, path)
    return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
  }

  /** Validate existing ancestors before a missing target is created. */
  async checkTarget(path: string): Promise<void> {
    if (!fullyQualifiedWorkspacePath(path) || !this.includes(path)) throw new Error(`Workspace must be inside ${this.root ?? 'an absolute directory'}`)
    if (this.root === undefined) return
    let ancestor = path
    while (true) {
      try {
        const canonical = await realpath(ancestor)
        if (relative(ancestor, canonical) !== '') throw new Error('Workspace target has a linked ancestor')
        break
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        const parent = dirname(ancestor)
        if (parent === ancestor) throw error
        ancestor = parent
      }
    }
  }

  /** Recreate a missing directory after validating the deployment boundary. */
  async prepare(path: string): Promise<void> {
    await this.checkTarget(path)
    await mkdir(path, { recursive: true })
    await this.assert(path)
  }

  /** @param path - Existing candidate directory. @returns Resolution when selection is allowed; rejects links outside the root. */
  async assert(path: string): Promise<void> {
    if (this.root === undefined) return
    const reject = (): never => { throw new Error(`工作区只能选择 ${this.root} 及其子目录；目录外的历史工作区需要先迁移。`) }
    if (!this.includes(path)) reject()
    const canonicalRoot = await realpath(this.root)
    // A junction at the deployment root must not silently redirect all workspaces elsewhere.
    if (relative(this.root, canonicalRoot) !== '') reject()
    if (!this.includes(await realpath(path))) reject()
  }
}
