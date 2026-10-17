import type { IconProps } from './icons/props.ts'
import { MascotLogo } from './MascotLogo.tsx'

/** Display options for the BHSS wordmark. */
export interface BrandWordmarkProps extends IconProps {
  /** Product name localized by the caller. */
  label: string
  includeMark?: boolean | undefined
}

/** Render the BHSS mascot and product name together. */
export function BrandWordmark({ size = 24, className, label, includeMark = true }: BrandWordmarkProps) {
  return (
    <span className={className} aria-hidden="true" style={{ alignItems: 'center', display: 'inline-flex', gap: size * 0.3, height: size, whiteSpace: 'nowrap' }}>
      {includeMark && <MascotLogo size={size} />}
      <span style={{ fontSize: size * 0.7, fontWeight: 700 }}>{label}</span>
    </span>
  )
}
