import { mainSend } from '@common/mainIpc'
import { BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'node:path'
import { openDevTools as handleOpenDevTools } from '@main/utils'
import USER_API_RENDERER_EVENT_NAME from './rendererEvent/name'
import { getScript } from './utils'

let browserWindow: Electron.BrowserWindow | null = null

let html: string | null = null
let dir: string | null = null

const denyEvents = [
  'will-navigate',
  'will-redirect',
  'will-attach-webview',
  'will-prevent-unload',
  'media-started-playing',
] as const


export const getProxy = () => {
  if (global.lx.appSetting['network.proxy.enable'] && global.lx.appSetting['network.proxy.host']) {
    return {
      host: global.lx.appSetting['network.proxy.host'],
      port: global.lx.appSetting['network.proxy.port'],
    }
  }
  const envProxy = envParams.cmdParams['proxy-server']
  if (envProxy) {
    if (envProxy && typeof envProxy == 'string') {
      const [host, port = ''] = envProxy.split(':')
      return {
        host,
        port,
      }
    }
  }
  return {
    host: '',
    port: '',
  }
}
const handleUpdateProxy = (keys: Array<keyof LX.AppSetting>) => {
  if (keys.includes('network.proxy.enable') || (global.lx.appSetting['network.proxy.enable'] && keys.some(k => k.startsWith('network.proxy.')))) {
    sendEvent(USER_API_RENDERER_EVENT_NAME.proxyUpdate, getProxy())
  }
}

const winEvent = () => {
  if (!browserWindow) return
  browserWindow.on('closed', () => {
    browserWindow = null
  })
}

export const createWindow = async(userApi: LX.UserApi.UserApiInfo) => {
  await closeWindow()
  dir ??= process.env.NODE_ENV !== 'production' ? webpackUserApiPath : path.join(__dirname, 'userApi')

  if (!html) {
    // eslint-disable-next-line require-atomic-updates
    html = await fs.promises.readFile(path.join(dir, 'renderer/user-api.html'), 'utf8')
  }
  const preloadUrl = process.env.NODE_ENV !== 'production'
    ? `${path.join(__dirname, '../dist/user-api-preload.js')}`
    : `${path.join(__dirname, 'user-api-preload.js')}`
  // console.log(preloadUrl)

  /**
   * Initial window options
   */
  browserWindow = new BrowserWindow({
    // enableRemoteModule: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    roundedCorners: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      // worldSafeExecuteJavaScript: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: false,

      spellcheck: false,
      autoplayPolicy: 'document-user-activation-required',
      enableWebSQL: false,
      disableDialogs: true,
      // nativeWindowOpen: false,
      webgl: false,
      images: false,

      preload: preloadUrl,
    },
  })

  for (const eventName of denyEvents) {
    // @ts-expect-error
    browserWindow.webContents.on(eventName, (event: Electron.Event) => {
      event.preventDefault()
    })
  }
  browserWindow.webContents.session.setPermissionRequestHandler((webContents, permission, resolve) => {
    if (webContents === browserWindow?.webContents) {
      resolve(false)
      return
    }
    resolve(true)
  })
  browserWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' }
  })

  winEvent()

  const win = browserWindow
  win.once('ready-to-show', () => {
    void (async() => {
      if (browserWindow !== win || win.isDestroyed()) return
      const script = await getScript(userApi.id)
      if (browserWindow !== win || win.isDestroyed()) return
      global.lx.event_app.on('updated_config', handleUpdateProxy)
      sendEvent(USER_API_RENDERER_EVENT_NAME.initEnv, { ...userApi, script, proxy: getProxy() })
    })()
  })

  // console.log(html.replace('</body>', `<script>${userApi.script}</script></body>`))
  // const randomNum = Math.random().toString().substring(2, 10)
  await win.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(html))

  // global.modules.userApiWindow.loadFile(join(dir, 'renderer/user-api.html'))
  // global.modules.userApiWindow.webContents.openDevTools()
}

export const isCurrentUserApiWebContents = (contents?: Electron.WebContents | null) => {
  return !!browserWindow && !browserWindow.isDestroyed() && browserWindow.webContents === contents
}

export const closeWindow = async() => {
  global.lx.event_app.off('updated_config', handleUpdateProxy)
  if (!browserWindow) return
  const closing = browserWindow
  browserWindow = null
  await Promise.all([
    closing.webContents.session.clearAuthCache(),
    closing.webContents.session.clearStorageData(),
    closing.webContents.session.clearCache(),
  ]).catch(() => undefined)
  if (!closing.isDestroyed()) closing.destroy()
}

export const sendEvent = <T = any>(name: string, params?: T) => {
  if (!browserWindow) return
  mainSend(browserWindow, name, params)
}

export const openDevTools = () => {
  if (!browserWindow) return
  handleOpenDevTools(browserWindow.webContents)
}
