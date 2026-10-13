import { closeWindow } from './main'
import { getUserApis, importApi as handleImportApi, removeApi as handleRemoveApi, setAllowShowUpdateAlert as saveAllowShowUpdateAlert } from './utils'
import { loadApi, setAllowShowUpdateAlert as setRendererEventAllowShowUpdateAlert, init } from './rendererEvent/rendererEvent'
import { BUILTIN_USER_API_IDS, USER_API_AUTO_ID, isProtectedUserApiId } from '@common/sources/builtin/ids'

let userApiId: string | null
let setApiChain: Promise<void> = Promise.resolve()

export const getApiList = getUserApis

export const importApi = async(script: string): Promise<LX.UserApi.ImportUserApi> => {
  return {
    apiInfo: await handleImportApi(script),
    apiList: getUserApis(),
  }
}
export const removeApi = async(ids: string[]): Promise<LX.UserApi.UserApiInfo[]> => {
  const removable = ids.filter(id => !isProtectedUserApiId(id))
  if (userApiId && removable.includes(userApiId)) {
    userApiId = null
    await closeWindow()
  }
  handleRemoveApi(removable)
  return getUserApis()
}

const setApiNow = async(id: string) => {
  userApiId = null
  await closeWindow()
  // 虚拟项没有脚本。若调用方传入自动切换，落到清单里的第一个内置源。
  const targetId = id === USER_API_AUTO_ID ? (BUILTIN_USER_API_IDS[0] ?? '') : id
  const apiList = getUserApis()
  if (!apiList.some(a => a.id === targetId)) return
  userApiId = targetId
  await loadApi(targetId)
}

export const setApi = async(id: string) => {
  const task = setApiChain.then(async() => {
    await setApiNow(id)
  })
  // 失败也继续排队，避免一次加载失败卡住后续切换
  setApiChain = task.catch(() => {})
  await task
}

export const setAllowShowUpdateAlert = (id: string, enable: boolean) => {
  saveAllowShowUpdateAlert(id, enable)
  setRendererEventAllowShowUpdateAlert(id, enable)
}


export * from './rendererEvent/rendererEvent'

export default () => {
  init()

  global.lx.event_app.on('main_window_close', () => {
    void closeWindow()
  })
}
