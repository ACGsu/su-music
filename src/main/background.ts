import type { BrowserWindow, Menu, MenuItemConstructorOptions, Tray } from 'electron'
import type { PlayerState } from '../shared/playback.ts'

type Control = 'resume' | 'pause' | 'previous' | 'next'
interface BackgroundOptions {
  window: () => BrowserWindow | null
  player: () => PlayerState | null
  createTray: () => Tray
  createMenu: (items: MenuItemConstructorOptions[]) => Menu
  command: (action: Control) => void
  quit: () => void
  error: (error: unknown) => void
}

// Keep the window and audio alive only while there is a usable way to restore it.
export class BackgroundPlayback {
  private tray: Tray | null = null
  private quitting = false
  private menuState = ''
  private readonly options: BackgroundOptions
  constructor(options: BackgroundOptions) { this.options = options }

  setEnabled(enabled: boolean): void {
    if (!enabled) {
      const window = this.options.window()
      if (window && !window.isDestroyed() && !window.isVisible()) this.showWindow()
      this.close()
      return
    }
    if (this.tray && !this.tray.isDestroyed()) return
    try {
      this.tray = this.options.createTray()
      this.tray.setToolTip('Su Music')
      this.tray.on('double-click', () => this.showWindow())
      this.refreshMenu()
    } catch {
      this.close()
      throw new Error('TRAY_UNAVAILABLE')
    }
  }

  showWindow(): void {
    const window = this.options.window()
    if (!window || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  handleClose(event: { preventDefault(): void }): void {
    if (this.quitting || !this.tray || this.tray.isDestroyed()) return
    event.preventDefault()
    this.options.window()?.hide()
  }

  refreshMenu(current?: PlayerState): void {
    if (!this.tray || this.tray.isDestroyed()) return
    const state = current ?? this.options.player(), enabled = Boolean(state?.queue.length)
    const key = `${enabled}:${Boolean(state?.desiredPlaying)}`
    if (key === this.menuState) return
    const control = (action: Control) => () => {
      try { this.options.command(action) } catch (error) { this.options.error(error) }
    }
    this.tray.setContextMenu(this.options.createMenu([
      { label: '显示窗口', click: () => this.showWindow() },
      { type: 'separator' },
      { label: state?.desiredPlaying ? '暂停' : '播放', enabled, click: control(state?.desiredPlaying ? 'pause' : 'resume') },
      { label: '上一首', enabled, click: control('previous') },
      { label: '下一首', enabled, click: control('next') },
      { type: 'separator' },
      { label: '退出', click: () => { this.prepareQuit(); this.options.quit() } }
    ]))
    this.menuState = key
  }

  prepareQuit(): void { this.quitting = true }
  close(): void {
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy()
    this.tray = null
    this.menuState = ''
  }
}
