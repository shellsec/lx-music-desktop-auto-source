import { apiSource, qualityList, userApi } from '@renderer/store'
import { appSetting } from '@renderer/store/setting'
import { setUserApi as setUserApiAction, refreshUserApiSources } from '@renderer/utils/ipc'
import {
  USER_API_AUTO_ID,
  isAutoUserApiId,
  isImportedUserApiId,
} from '@common/sources/user/ids'
import { runUserApiFailover, markSourceFailed, hasSourceFailed, getPlayingSongKey } from '@common/sources/user/failover'

/** 当前隐藏窗口里实际 load 的导入源。自动模式下不等于设置里的 user_api_auto */
let loadedUserApiId: string | null = null
/** 这次 load 期望的脚本 id。状态事件对不上就丢掉，避免旧窗口把新窗口的 init 写脏 */
let expectedLoadId: string | null = null
let initGeneration = 0
let loadChain: Promise<unknown> = Promise.resolve()
let failoverDepth = 0
/** 当前这扇初始化门闩最后一次结束时是不是成功。失败或超时记成 false。 */
let initGateOpen = false

export const getExpectedLoadId = () => expectedLoadId
export const setExpectedLoadId = (id: string | null) => {
  expectedLoadId = id
}
export const isUserApiFailoverRunning = () => failoverDepth > 0

export const getLoadedUserApiId = () => loadedUserApiId

export const setLoadedUserApiId = (id: string | null) => {
  loadedUserApiId = id && isImportedUserApiId(id) ? id : null
}

export const getImportedUserApiIds = (): string[] => userApi.list.map(api => api.id).filter(isImportedUserApiId)

export const resolveInitialUserApiId = (): string => {
  const ids = getImportedUserApiIds()
  return ids[0] ?? ''
}

/** Preserve the order configured by the user. */
export const getUserApiFailoverOrder = (exclude: string[] = []): string[] => {
  return getImportedUserApiIds().filter(id => !exclude.includes(id) && !hasSourceFailed(id))
}

export const isAutoUserApiSource = (apiId = appSetting['common.apiSource']) => {
  return isAutoUserApiId(apiId)
}

/** 换源串行执行，避免隐藏窗口重叠创建 */
export const enqueueUserApiTask = async <T>(task: () => Promise<T>): Promise<T> => {
  const run = loadChain.then(task, task)
  loadChain = run.then(() => undefined, () => undefined)
  return await run
}

/**
 * 换源时递增代数。迟到的旧脚本 init 调到新的回调也会被丢掉，
 * 避免把上一个窗口的结果写成当前音源已就绪。
 */
export const beginUserApiInit = () => {
  if (!window.lx.apiInitPromise[1]) window.lx.apiInitPromise[2](false)
  const generation = ++initGeneration
  window.lx.apiInitPromise[0] = new Promise<boolean>(resolve => {
    window.lx.apiInitPromise[1] = false
    window.lx.apiInitPromise[2] = (result: boolean) => {
      if (generation !== initGeneration) return
      window.lx.apiInitPromise[1] = true
      initGateOpen = result
      resolve(result)
    }
  })
}

const waitApiReady = async(timeoutMs = 25_000) => {
  const generation = initGeneration
  const pending = window.lx.apiInitPromise[0]
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>(resolve => {
    timer = setTimeout(() => {
      // 超时也要把这一代门闩结束掉，不能留下永远 pending 的 Promise
      if (generation === initGeneration && !window.lx.apiInitPromise[1]) {
        window.lx.apiInitPromise[2](false)
      }
      resolve(false)
    }, timeoutMs)
  })
  try {
    return await Promise.race([pending, timeout])
  } finally {
    if (timer != null) clearTimeout(timer)
  }
}

/** Release a failed initialization so the next playback attempt can retry. */
const releaseInitGateAfterFailure = () => {
  if (!window.lx.apiInitPromise[1]) window.lx.apiInitPromise[2](true)
  if (initGateOpen) return
  window.lx.apiInitPromise[0] = Promise.resolve(true)
  window.lx.apiInitPromise[1] = true
  initGateOpen = true
}

const isUserApiReady = (apiId: string) => {
  return loadedUserApiId === apiId && userApi.status && Object.keys(userApi.apis).length > 0
}

export const loadImportedUserApi = async(apiId: string) => enqueueUserApiTask(async() => {
  if (!getImportedUserApiIds().includes(apiId)) throw new Error('source not imported')
  if (isUserApiReady(apiId)) {
    if (!window.lx.apiInitPromise[1]) window.lx.apiInitPromise[2](true)
    if (appSetting['common.apiSource'] === USER_API_AUTO_ID) apiSource.value = USER_API_AUTO_ID
    return true
  }
  beginUserApiInit()
  expectedLoadId = apiId
  qualityList.value = {}
  userApi.apis = {}
  userApi.status = false
  userApi.message = 'initing'
  setLoadedUserApiId(null)
  await setUserApiAction(apiId)
  const ok = await waitApiReady()
  if (!ok) throw new Error('source init failed')
  setLoadedUserApiId(apiId)
  if (appSetting['common.apiSource'] === USER_API_AUTO_ID) apiSource.value = USER_API_AUTO_ID
  return true
})

/** 设置保持为自动切换，实际加载优先导入源 */
export const activateAutoUserApi = async() => {
  const id = resolveInitialUserApiId()
  if (!id) throw new Error('no imported source')
  failoverDepth++
  try {
    for (const candidate of getImportedUserApiIds()) {
      try {
        await loadImportedUserApi(candidate)
        return
      } catch (err) { console.log(err) }
    }
    releaseInitGateAfterFailure()
  } finally {
    failoverDepth--
  }
}

/**
 * 只在取播放地址失败后调用。先按本地名单换源。
 * 自动模式保持设置不变。
 */
export const tryUserApiMusicUrlFailover = async(
  tryOnce: () => Promise<{ url: string, type: LX.Quality }>,
): Promise<{ url: string, type: LX.Quality }> => {
  const settingId = appSetting['common.apiSource']
  if (!isAutoUserApiSource(settingId)) throw new Error('not auto mode')

  const songKey = getPlayingSongKey()
  const subscriptionUrl = appSetting['common.sourceListUrl'] ?? ''
  const isCurrent = () => appSetting['common.apiSource'] === settingId &&
    getPlayingSongKey() === songKey && (appSetting['common.sourceListUrl'] ?? '') === subscriptionUrl
  const currentId = getLoadedUserApiId()
  if (currentId) markSourceFailed(currentId)
  failoverDepth++
  try {
    return await runUserApiFailover({
      subscriptionUrl,
      isCurrent,
      refresh: async() => {
        if (!isCurrent()) throw new Error('source changed')
        const result = await refreshUserApiSources(subscriptionUrl)
        if (!isCurrent()) throw new Error('source changed')
        if (result.updated) {
          userApi.list = result.list
          setLoadedUserApiId(null)
          setExpectedLoadId(null)
          userApi.status = false
          userApi.apis = {}
          qualityList.value = {}
        }
        return { updated: result.updated }
      },
      loadOrder: () => {
        const loadedId = getLoadedUserApiId()
        const current = loadedId ?? (settingId === USER_API_AUTO_ID ? '' : settingId)
        return getUserApiFailoverOrder(current ? [current] : [])
      },
      tryId: async(id) => {
        if (!isCurrent()) throw new Error('source changed')
        try {
          console.log('[userApi failover] try', id)
          await loadImportedUserApi(id)
          if (!isCurrent()) throw new Error('source changed')
          const result = await tryOnce()
          if (!result?.url || !/^https?:\/\//i.test(result.url)) throw new Error('invalid music url')
          return result
        } catch (err) {
          if (isCurrent()) markSourceFailed(id)
          throw err
        }
      },
      onGiveUp: () => {
        releaseInitGateAfterFailure()
      },
    })
  } finally {
    failoverDepth--
  }
}
