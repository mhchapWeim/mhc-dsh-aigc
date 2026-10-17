import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { WorkspaceDirectoryPolicy } from '../src/directory-policy.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

it('allows the root and its children, rejecting siblings, traversal and junction escapes', async () => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'wanzai-policy-')))
  roots.push(temporary)
  const root = join(temporary, 'work')
  const child = join(root, 'project')
  const outside = join(temporary, 'work-other')
  await mkdir(child, { recursive: true }); await mkdir(outside)
  const policy = new WorkspaceDirectoryPolicy(root)
  await expect(policy.assert(root)).resolves.toBeUndefined()
  await expect(policy.assert(child)).resolves.toBeUndefined()
  await expect(policy.assert(outside)).rejects.toThrow('工作区只能选择')
  await expect(policy.assert(join(root, '..', 'work-other'))).rejects.toThrow()
  await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(policy.assert(join(root, 'escape'))).rejects.toThrow('工作区只能选择')
  await symlink(outside, join(temporary, 'linked-root'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(new WorkspaceDirectoryPolicy(join(temporary, 'linked-root')).assert(join(temporary, 'linked-root'))).rejects.toThrow()
})

it('rejects relative configured roots and leaves unrestricted deployments unchanged', async () => {
  expect(() => new WorkspaceDirectoryPolicy('relative')).toThrow('fully qualified')
  await expect(new WorkspaceDirectoryPolicy().assert('/unrestricted/nonexistent')).resolves.toBeUndefined()
})
