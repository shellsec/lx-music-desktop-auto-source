import { apiSource, qualityList, userApi } from '@renderer/store'
import { appSetting, setApiSource } from '@renderer/store/setting'
import { setUserApi as setUserApiAction } from '@renderer/utils/ipc'
import {
  BUILTIN_USER_API_IDS,
  USER_API_AUTO_ID,
  isAutoOrBuiltinUserApiId,
  isBuiltinUserApiId,
} from '@common/sources/builtin/ids'

/** 最近一次成功解析的内置源（仅内存，重启后从列表头开始） */
let preferredBuiltinId: string | null = null
/** 当前隐藏窗口里实际 load 的内置源。自动模式下不等于设置里的 user_api_auto */
let loadedBuiltinId: string | null = null
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

export const getLoadedBuiltinId = () => loadedBuiltinId

export const setLoadedBuiltinId = (id: string | null) => {
  loadedBuiltinId = id && isBuiltinUserApiId(id) ? id : null
}

export const setPreferredBuiltinId = (id: string | null) => {
  preferredBuiltinId = id && isBuiltinUserApiId(id) ? id : null
}

export const resolveInitialBuiltinId = (): string => {
  if (preferredBuiltinId && isBuiltinUserApiId(preferredBuiltinId)) return preferredBuiltinId
  return BUILTIN_USER_API_IDS[0] ?? ''
}

/** 成功过的内置源排到最前，其余保持清单顺序 */
export const getBuiltinFailoverOrder = (exclude: string[] = []): string[] => {
  const ids = BUILTIN_USER_API_IDS.filter(id => !exclude.includes(id))
  if (!preferredBuiltinId || !(ids as readonly string[]).includes(preferredBuiltinId)) return ids
  return [preferredBuiltinId, ...ids.filter(id => id !== preferredBuiltinId)]
}

export const isAutoOrBuiltinApiSource = (apiId = appSetting['common.apiSource']) => {
  return isAutoOrBuiltinUserApiId(apiId)
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

/**
 * 全部内置源都失败后，把门闩收成「可以继续播」。
 * 初始化失败时门闩是 false，超时则在 waitApiReady 里已经结束。
 * 这里若仍是 false，换成已完成的 true，当前这首歌才能走进原来的平台换源，
 * 下一首也不会被 source init failed 挡住。设置保持不动。
 */
const releaseInitGateAfterBuiltinFailure = () => {
  if (!window.lx.apiInitPromise[1]) window.lx.apiInitPromise[2](true)
  if (initGateOpen) return
  window.lx.apiInitPromise[0] = Promise.resolve(true)
  window.lx.apiInitPromise[1] = true
  initGateOpen = true
}

const isBuiltinReady = (apiId: string) => {
  return loadedBuiltinId === apiId && userApi.status && Object.keys(userApi.apis).length > 0
}

export const loadBuiltinUserApi = async(apiId: string) => enqueueUserApiTask(async() => {
  if (!isBuiltinUserApiId(apiId)) throw new Error('not builtin api')
  if (isBuiltinReady(apiId)) {
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
  setLoadedBuiltinId(null)
  await setUserApiAction(apiId)
  const ok = await waitApiReady()
  if (!ok) throw new Error('source init failed')
  setLoadedBuiltinId(apiId)
  if (appSetting['common.apiSource'] === USER_API_AUTO_ID) apiSource.value = USER_API_AUTO_ID
  return true
})

/** 设置保持为自动切换，实际加载优先内置源 */
export const activateAutoUserApi = async() => {
  const id = resolveInitialBuiltinId()
  if (!id) throw new Error('no builtin api')
  await loadBuiltinUserApi(id)
}

/**
 * 只在取播放地址失败后调用。按序换下一个内置源，再请求同一首歌。
 * 设置是自动时不改设置；用户手动选了某个内置源时，成功后记成那个源。
 */
export const tryBuiltinMusicUrlFailover = async(
  tryOnce: () => Promise<{ url: string, type: LX.Quality }>,
): Promise<{ url: string, type: LX.Quality }> => {
  const settingId = appSetting['common.apiSource']
  if (!isAutoOrBuiltinApiSource(settingId)) throw new Error('not auto mode')

  const loadedId = getLoadedBuiltinId()
  // 自动模式且没有已加载的内置源时，不排除清单头，下一首可以从头再试
  const current = loadedId ?? (settingId === USER_API_AUTO_ID ? '' : settingId)
  const order = getBuiltinFailoverOrder(current ? [current] : [])
  let lastErr: Error | null = null
  failoverDepth++

  try {
    for (const id of order) {
      if (appSetting['common.apiSource'] !== settingId) throw new Error('source changed')
      try {
        console.log('[userApi failover] try', id)
        await loadBuiltinUserApi(id)
        if (appSetting['common.apiSource'] !== settingId) throw new Error('source changed')
        const result = await tryOnce()
        if (!result?.url || !/^https?:\/\//i.test(result.url)) throw new Error('invalid music url')
        setPreferredBuiltinId(id)
        if (settingId !== USER_API_AUTO_ID && isBuiltinUserApiId(settingId)) setApiSource(id)
        return result
      } catch (err: any) {
        lastErr = err instanceof Error ? err : new Error(String(err?.message ?? err))
        console.log('[userApi failover] fail', id, lastErr.message)
      }
    }
    releaseInitGateAfterBuiltinFailure()
    throw lastErr ?? new Error('all builtin sources failed')
  } finally {
    failoverDepth--
  }
}
