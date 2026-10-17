/**
 * Framework-free boot page and failure report. It remains available when a
 * client plugin fails because React arrives only with the UI renderer.
 * @module @deepseek-ai/dsh-client-web/src/boot-page
 */
import type { LoaderEntryState } from './loader-status.ts'
import css from './boot-page.module.css'

/** Create a div with one module class and optional text. */
function div(className: string | undefined, text?: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = className ?? ''
  if (text !== undefined) el.textContent = text
  return el
}

/** Kernel-owned page mounted below the application's root element. */
export class BootPage {
  private readonly root: HTMLDivElement
  private readonly card: HTMLDivElement
  private readonly brand: HTMLDivElement
  private readonly tagline: HTMLDivElement
  private readonly wordmark: HTMLDivElement
  private readonly spinner: HTMLDivElement
  private readonly hint: HTMLDivElement
  private readonly entrance: Promise<void>
  private readonly desktop: boolean
  private readonly reducedMotion: boolean
  private localeReveal: Promise<void> = Promise.resolve()
  private activeLocale = ''
  private readonly states = new Map<string, LoaderEntryState>()
  private readonly active = new Set<string>()
  private total = 0
  private failure: string | undefined

  /**
   * Build and attach the boot page.
   * @param container - Application mount point.
   */
  constructor(container: HTMLElement) {
    this.desktop = (globalThis as { dshDesktopBoot?: object }).dshDesktopBoot !== undefined
    this.reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    this.root = div(css.boot)
    this.root.dataset.dshBoot = ''
    if (this.desktop) this.root.dataset.desktop = ''
    this.card = div(css.card)
    this.brand = div(css.brand)
    const mascot = document.createElement('img')
    mascot.className = css.mascot ?? ''
    mascot.src = '/office-assistant.svg'
    mascot.alt = ''
    mascot.width = 190
    mascot.height = 190
    this.wordmark = div(css.wordmark)
    this.wordmark.append(div(css.wordmarkChinese, '弯崽工作伙伴'))
    this.brand.append(mascot, this.wordmark)
    this.tagline = div(css.tagline)
    this.spinner = div(css.spinner)
    this.spinner.dataset.dshBootSpinner = ''
    this.hint = div(css.hint)
    this.card.append(this.brand, this.tagline, this.spinner, this.hint)
    this.root.append(this.card)
    container.append(this.root)
    // Desktop resolves the saved preference through its carrier; do not flash browser-language copy.
    if (!this.desktop) this.setLocale(document.documentElement.lang || navigator.language)
    this.entrance = this.desktop && !this.reducedMotion
      ? new Promise(resolve => { setTimeout(resolve, 1550) }) : Promise.resolve()
    this.updateProgress()
  }

  /** Let the one-time desktop entrance finish before replacing its page. */
  async waitForEntrance(): Promise<void> {
    await Promise.all([this.entrance, this.localeReveal])
  }

  /** Update startup copy when the carrier supplies the selected language. */
  setLocale(locale: string): void {
    this.activeLocale = locale
    const chinese = locale.toLowerCase().startsWith('zh')
    this.tagline.textContent = chinese ? '把繁琐交给我，把专注留给你。' : 'Less busywork. More room to focus.'
    this.hint.textContent = chinese ? '正在启动…' : 'Starting…'
    this.root.dataset.localeReady = ''
    if (this.desktop && !this.reducedMotion) {
      this.localeReveal = new Promise(resolve => { setTimeout(resolve, 550) })
    }
  }

  /**
   * Set the number of loader entries represented by the progress arc.
   * @param total - Complete boot roster size.
   */
  setTotal(total: number): void {
    this.total = total
    this.updateProgress()
  }

  /**
   * Project one loader entry's fiber state.
   * @param id - Loader entry name.
   * @param state - Projected fiber state.
   */
  setState(id: string, state: LoaderEntryState): void {
    this.states.set(id, state)
    if (state === 'active') this.active.add(id)
    this.updateProgress()
    this.render()
  }

  /**
   * Display the boot failure report.
   * @param message - Failure report text.
   */
  fail(message: string): void {
    this.failure = message
    this.render()
  }

  /** Detach the page before or after the UI renderer takes the mount point. */
  dispose(): void {
    this.root.remove()
  }

  /** Redraw the state-dependent content below the wordmark. */
  private render(): void {
    const failed = [...this.states].filter(([, state]) => state === 'failed').map(([id]) => id)
    if (this.failure === undefined && failed.length === 0) {
      if (this.spinner.parentElement !== this.card) {
        this.card.replaceChildren(this.brand, this.tagline, this.spinner, this.hint)
      }
      return
    }
    const report = div(css.failed)
    report.append(div(css.failedTitle, (this.activeLocale || navigator.language).toLowerCase().startsWith('zh')
      ? '插件加载失败' : 'Failed to load plugins'))
    for (const id of failed) report.append(div(css.failedItem, id))
    if (this.failure !== undefined) report.append(div(css.failedItem, this.failure))
    this.card.replaceChildren(this.brand, report)
  }

  /** Grow the rotating arc monotonically as loader entries activate. */
  private updateProgress(): void {
    const ratio = this.total === 0 ? 0 : Math.min(this.active.size / this.total, 1)
    this.spinner.style.setProperty('--dsh-boot-arc', `${String(Math.round(72 + ratio * 216))}deg`)
  }
}
