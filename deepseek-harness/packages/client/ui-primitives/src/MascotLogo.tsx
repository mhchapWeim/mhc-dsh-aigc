import type { IconProps } from './icons/props.ts'

/** Public asset path shared by the Web and desktop-hosted browser clients. */
export const BHSS_MASCOT_DATA_URL = '/bhss-office-assistant.svg'

/** BHSS mascot in a square layout box; object-fit preserves the source artwork ratio. */
export function MascotLogo({ size = 24, className }: IconProps) {
  return (
    <img
      src={BHSS_MASCOT_DATA_URL}
      width={size}
      height={size}
      className={className}
      style={{ objectFit: 'contain' }}
      alt=""
      aria-hidden="true"
    />
  )
}
