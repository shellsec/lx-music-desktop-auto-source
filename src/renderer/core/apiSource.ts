import { apiSource, qualityList, userApi } from '@renderer/store'
import { appSetting, setApiSource } from '@renderer/store/setting'
import { setUserApi as setUserApiAction } from '@renderer/utils/ipc'
import musicSdk from '@renderer/utils/musicSdk'
import apiSourceInfo from '@renderer/utils/musicSdk/api-source-info'
import { USER_API_AUTO_ID, isBuiltinUserApiId } from '@common/sources/builtin/ids'
import {
  activateAutoUserApi,
  beginUserApiInit,
  enqueueUserApiTask,
  getLoadedBuiltinId,
  loadBuiltinUserApi,
  setExpectedLoadId,
  setLoadedBuiltinId,
} from '@renderer/core/userApiFailover'

let prevId = ''

const fallbackApiSource = () => {
  const api = apiSourceInfo.find(item => !item.disabled)
  if (!api) return
  if (api.id != appSetting['common.apiSource']) setApiSource(api.id)
}

const isLoadedBuiltin = (apiId: string) => {
  return isBuiltinUserApiId(apiId) &&
    getLoadedBuiltinId() === apiId &&
    userApi.status &&
    Object.keys(userApi.apis).length > 0
}

export const setUserApi = async(apiId: string) => {
  // 失败换源已经把脚本加载好时，设置写回该 id 不要再关窗重开
  if (isLoadedBuiltin(apiId)) {
    prevId = apiId
    apiSource.value = apiId
    return
  }
  if (prevId == apiId) return
  prevId = apiId

  if (apiId === USER_API_AUTO_ID) {
    apiSource.value = apiId
    await activateAutoUserApi().catch(err => {
      if (prevId != apiId) return
      if (!window.lx.apiInitPromise[1]) window.lx.apiInitPromise[2](false)
      console.log(err)
      fallbackApiSource()
    })
  } else if (/^user_api/.test(apiId) && isBuiltinUserApiId(apiId)) {
    qualityList.value = {}
    userApi.status = false
    userApi.message = 'initing'
    apiSource.value = apiId
    await loadBuiltinUserApi(apiId).catch(err => {
      if (prevId != apiId) return
      if (!window.lx.apiInitPromise[1]) window.lx.apiInitPromise[2](false)
      console.log(err)
      fallbackApiSource()
    })
  } else if (/^user_api/.test(apiId)) {
    qualityList.value = {}
    userApi.status = false
    userApi.message = 'initing'
    await enqueueUserApiTask(async() => {
      if (prevId != apiId) return
      beginUserApiInit()
      setExpectedLoadId(apiId)
      setLoadedBuiltinId(null)
      userApi.apis = {}
      await setUserApiAction(apiId)
    }).then(() => {
      if (prevId != apiId) return
      apiSource.value = apiId
    }).catch(err => {
      if (prevId != apiId) return
      if (!window.lx.apiInitPromise[1]) window.lx.apiInitPromise[2](false)
      console.log(err)
      fallbackApiSource()
    })
  } else {
    setExpectedLoadId(null)
    setLoadedBuiltinId(null)
    // @ts-expect-error
    qualityList.value = musicSdk.supportQuality[apiId] ?? {}
    apiSource.value = apiId
    await enqueueUserApiTask(async() => {
      if (prevId != apiId) return
      beginUserApiInit()
      userApi.apis = {}
      await setUserApiAction(apiId)
      if (!window.lx.apiInitPromise[1]) window.lx.apiInitPromise[2](true)
    })
  }

  if (prevId != apiId) return
  if (apiId != appSetting['common.apiSource']) setApiSource(apiId)
}
