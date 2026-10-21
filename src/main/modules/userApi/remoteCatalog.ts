import { request } from '@common/utils/request'
import {
  isUserApiScriptText,
  parseRemoteSources,
} from '@common/sources/user/failover'
import { applyRemoteSources, getUserApis, hasRemoteSourceChanges } from './utils'

let pending: Promise<LX.UserApi.RefreshUserApiResult> | null = null

const fetchOnce = async(url: string) => {
  const response = await request<unknown>(url, {
    timeout: 15_000,
    maxRedirect: 3,
    retryNum: 0,
  })
  if (response.statusCode !== 200) throw new Error(`status ${response.statusCode ?? 0}`)
  return response.body
}

/**
 * sources.json 失败，或任一脚本取不到，就不改本地名单。
 */
const refreshNow = async(address: string): Promise<LX.UserApi.RefreshUserApiResult> => {
  const current = getUserApis()
  const url = address.trim()
  if (!url || !/^https:\/\//i.test(url)) return { updated: false, list: current }
  try {
    const refs = parseRemoteSources(await fetchOnce(url))
    if (!refs) return { updated: false, list: current }
    const remote = await Promise.all(refs.map(async item => {
      const body = await fetchOnce(item.url)
      if (typeof body !== 'string' || !isUserApiScriptText(body)) throw new Error(`invalid script ${item.id}`)
      return { ...item, script: body }
    }))
    if (!await hasRemoteSourceChanges(remote)) return { updated: false, list: getUserApis() }
    return { updated: true, list: applyRemoteSources(remote) }
  } catch (err) {
    console.log('[userApi remote] fallback failed', err)
    return { updated: false, list: getUserApis() }
  }
}

export const refreshUserApisFromRemote = async(url: string) => {
  if (!pending) {
    pending = refreshNow(url).finally(() => {
      pending = null
    })
  }
  return pending
}
