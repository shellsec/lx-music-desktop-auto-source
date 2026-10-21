import { STORE_NAMES } from '@common/constants'
import getStore from '@main/utils/store'
import zlib from 'node:zlib'
import { subscriptionUserApiId } from '@common/sources/user/catalog'
import type { RemoteSourceScript } from '@common/sources/user/failover'

let userApis: LX.UserApi.UserApiInfo[] | null
let scripts = new Map<string, string>()

const saveData = () => {
  getStore(STORE_NAMES.USER_API).set('userApis', userApis!.map(api => {
    return {
      ...api,
      script: scripts.get(api.id) ?? '',
    }
  }))
}

/** Load only explicitly imported scripts. Drop legacy bundled entries on upgrade. */
export const getUserApis = (): LX.UserApi.UserApiInfo[] => {
  if (userApis) return userApis
  const stored = getStore(STORE_NAMES.USER_API).get('userApis') as LX.UserApi.UserApiInfoFull[] | undefined
  userApis = []
  for (const api of Array.isArray(stored) ? stored : []) {
    if (api.id === 'user_api_auto' || api.id.startsWith('user_api_builtin_') || api.id.endsWith('_builtin')) continue
    const { script, ...info } = api
    if (!script) continue
    scripts.set(api.id, script)
    userApis.push({ ...info, allowShowUpdateAlert: info.allowShowUpdateAlert ?? false })
  }
  saveData()
  return userApis
}

const remoteCatalogOf = (remote: RemoteSourceScript[]) => remote.map(({ id, name, url }) => ({ id, name, url }))

/** Compare script contents too: a stable URL can serve an updated script. */
export const hasRemoteSourceChanges = async(remote: RemoteSourceScript[]) => {
  const list = getUserApis()
  const previous = getStore(STORE_NAMES.USER_API).get('sourceCatalog') as unknown
  if (JSON.stringify(previous) !== JSON.stringify(remoteCatalogOf(remote))) return true
  for (const item of remote) {
    const id = subscriptionUserApiId(item.id)
    const local = list.find(api => api.id === id)
    if (!local || local.name !== item.name || local.scriptUrl !== item.url || await getScript(id) !== item.script) return true
  }
  return false
}

/** Subscription updates replace matching subscription IDs, preserving local imports and order. */
export const applyRemoteSources = (remote: RemoteSourceScript[]) => {
  getUserApis()
  const remoteIds = new Set(remote.map(item => subscriptionUserApiId(item.id)))
  userApis = userApis!.filter(api => {
    if (!api.id.startsWith('user_api_subscription_') || remoteIds.has(api.id)) return true
    scripts.delete(api.id)
    return false
  })
  for (const item of remote) {
    const id = subscriptionUserApiId(item.id)
    const info = { ...parseScriptInfo(item.script), id, name: item.name, scriptUrl: item.url, allowShowUpdateAlert: false }
    const index = userApis.findIndex(api => api.id === id)
    if (index < 0) userApis.push(info)
    else userApis[index] = info
    scripts.set(id, deflateScriptSync(item.script))
  }
  saveData()
  getStore(STORE_NAMES.USER_API).set('sourceCatalog', remoteCatalogOf(remote))
  return userApis
}

const deflateScriptSync = (script: string) => {
  return 'gz_' + zlib.deflateSync(Buffer.from(script, 'utf8')).toString('base64')
}

const INFO_NAMES = {
  name: 24,
  description: 36,
  author: 56,
  homepage: 1024,
  version: 36,
} as const
type INFO_NAMES_Type = typeof INFO_NAMES
const matchInfo = (scriptInfo: string) => {
  const infoArr = scriptInfo.split(/\r?\n/)
  const rxp = /^\s?\*\s?@(\w+)\s(.+)$/
  const infos: Partial<Record<keyof typeof INFO_NAMES, string>> = {}
  for (const info of infoArr) {
    const result = rxp.exec(info)
    if (!result) continue
    const key = result[1] as keyof typeof INFO_NAMES
    if (INFO_NAMES[key] == null) continue
    infos[key] = result[2].trim()
  }

  for (const [key, len] of Object.entries(INFO_NAMES) as Array<{ [K in keyof INFO_NAMES_Type]: [K, INFO_NAMES_Type[K]] }[keyof INFO_NAMES_Type]>) {
    infos[key] ||= ''
    if (infos[key] == null) infos[key] = ''
    else if (infos[key].length > len) infos[key] = infos[key].substring(0, len) + '...'
  }

  return infos as Record<keyof typeof INFO_NAMES, string>
}
const parseScriptInfo = (script: string) => {
  const result = /^\/\*[\S|\s]+?\*\//.exec(script)
  if (!result) throw new Error('无效的自定义源文件')

  let scriptInfo = matchInfo(result[0])

  scriptInfo.name ||= `user_api_${new Date().toLocaleString()}`
  return scriptInfo
}
const deflateScript = async(script: string) => new Promise<string>((resolve, reject) => {
  zlib.deflate(Buffer.from(script, 'utf8'), (err, buf) => {
    if (err) {
      reject(err)
      return
    }
    resolve('gz_' + buf.toString('base64'))
  })
})
const inflateScript = async(script: string) => new Promise<string>((resolve, reject) => {
  if (script.startsWith('gz_')) {
    zlib.inflate(Buffer.from(script.substring(3), 'base64'), (err, buf) => {
      if (err) {
        reject(err)
        return
      }
      resolve(buf.toString('utf8'))
    })
  } else resolve(script)
})
export const importApi = async(scriptRaw: string): Promise<LX.UserApi.UserApiInfo> => {
  let scriptInfo = parseScriptInfo(scriptRaw)
  const script = await deflateScript(scriptRaw)
  getUserApis()
  for (const api of userApis!) {
    const existingScript = scripts.get(api.id)
    if (existingScript === script) {
      throw new Error(`导入失败，脚本内容与已有的源「${api.name}」相同`)
    }
  }
  const apiInfo = {
    id: `user_api_${Math.random().toString().substring(2, 5)}_${Date.now()}`,
    ...scriptInfo,
    allowShowUpdateAlert: true,
  }
  userApis!.push(apiInfo)
  scripts.set(apiInfo.id, script)
  saveData()
  return apiInfo
}

export const removeApi = (ids: string[]) => {
  if (!userApis) return
  for (let index = userApis.length - 1; index > -1; index--) {
    const id = userApis[index].id
    if (!ids.includes(id)) continue
    scripts.delete(id)
    userApis.splice(index, 1)
  }
  saveData()
}

export const setAllowShowUpdateAlert = (id: string, enable: boolean) => {
  const targetApi = userApis?.find(api => api.id == id)
  if (!targetApi) return
  targetApi.allowShowUpdateAlert = enable
  saveData()
}

export const getScript = async(id: string) => {
  const stored = scripts.get(id)
  if (stored) {
    try {
      const text = await inflateScript(stored)
      if (text) return text
    } catch (err) {
      console.log('inflate user api script failed', id, err)
    }
  }
  return ''
}

export const reorderApis = (ids: string[]) => {
  const list = getUserApis()
  if (ids.length !== list.length || new Set(ids).size !== list.length || ids.some(id => !list.some(api => api.id === id))) {
    throw new Error('invalid source order')
  }
  userApis = ids.map(id => list.find(api => api.id === id)!)
  saveData()
  return userApis
}
