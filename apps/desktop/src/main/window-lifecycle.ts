import type { BrowserWindow } from 'electron'

// Keep close interception at the native window boundary. A quit or an OS
// session end must always win, including when an update fails during quit.
export class WindowLifecycle {
  private quitting = false
  private installing = false

  constructor(private readonly platform = process.platform) {}

  get exiting(): boolean {
    return this.quitting || this.installing
  }

  beginQuit(): void {
    this.quitting = true
  }

  setInstalling(installing: boolean): void {
    this.installing = installing
  }

  attach(window: BrowserWindow, hasTray: () => boolean, onBackground: () => void): void {
    window.on('close', event => {
      if (this.exiting) return
      event.preventDefault()
      // Linux shells can accept a Tray without displaying it (GNOME without
      // an extension). Keep a taskbar/overview entry there, and if tray setup
      // failed on Windows, so Open and File > Quit are always reachable.
      if (this.platform === 'linux' || (this.platform === 'win32' && !hasTray())) window.minimize()
      else window.hide()
      onBackground()
    })
    // Windows does not emit before-quit at logoff/shutdown. Do not veto or
    // delay either session event, or treat a cancellable query as a quit.
    window.on('session-end', () => this.beginQuit())
  }
}
