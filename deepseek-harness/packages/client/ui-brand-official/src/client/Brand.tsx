import type { SidebarBrandMarkOwnerProps, SidebarBrandNameOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { MascotLogo } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Render the official mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the BHSS mark.
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <MascotLogo size={size} />
}

/**
 * Render the BHSS product name without its independently slotted mark.
 * @returns the BHSS name.
 */
export function OfficialBrandName({ label }: SidebarBrandNameOwnerProps) {
  return <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{label}</span>
}
