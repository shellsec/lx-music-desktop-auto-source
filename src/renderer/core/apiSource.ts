import { apiSource, qualityList, userApi } from '@renderer/store'
import { appSetting, setApiSource } from '@renderer/store/setting'
import { setUserApi as setUserApiAction } from '@renderer/utils/ipc'
import musicSdk from '@renderer/utils/musicSdk'
import apiSourceInfo from '@renderer/utils/musicSdk/api-source-info'
import { USER_API_AUTO_ID, isImportedUserApiId } from '@common/sources/user/ids'
import {
  activateAutoUserApi,
  beginUserApiInit,
  enqueueUserApiTask,
  getLoadedUserApiId,
  loadImportedUserApi,
  setExpectedLoadId,
  setLoadedUserApiId,
} from '@renderer/core/userApiFailover'

let prevId: string | null = null

const fallbackApiSource = () => {
  const api = apiSourceInfo.find(item => !item.disabled)
  if (!api) return
  if (api.id != appSetting['common.apiSource']) setApiSource(api.id)
}

const isLoadedUserApi = (apiId: string) => {
  return isImportedUserApiId(apiId) &&
    getLoadedUserApiId() === apiId &&
    userApi.status &&
    Object.keys(userApi.apis).length > 0
}

export const setUserApi = async(apiId: string, force = false) => {
  // 失败换源已经把脚本加载好时，设置写回该 id 不要再关窗重开
  if (!force && isLoadedUserApi(apiId)) {
    prevId = apiId
    apiSource.value = apiId
    return
  }
  if (!force && prevId == apiId) return
  prevId = apiId
  if (force) {
    setLoadedUserApiId(null)
    userApi.status = false
    userApi.apis = {}
    qualityList.value = {}
  }

  if (apiId === USER_API_AUTO_ID) {
    apiSource.value = apiId
    await activateAutoUserApi().catch(err => {
      if (prevId != apiId) return
      if (!window.lx.apiInitPromise[1]) window.lx.apiInitPromise[2](false)
      console.log(err)
      fallbackApiSource()
    })
  } else if (/^user_api/.test(apiId) && isImportedUserApiId(apiId)) {
    qualityList.value = {}
    userApi.status = false
    userApi.message = 'initing'
    apiSource.value = apiId
    await loadImportedUserApi(apiId).catch(err => {
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
      setLoadedUserApiId(null)
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
    setLoadedUserApiId(null)
    userApi.status = false
    userApi.message = '请在设置中导入自定义源'
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
