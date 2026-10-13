import { userApis as defaultUserApis } from './config'
import { STORE_NAMES } from '@common/constants'
import getStore from '@main/utils/store'
import zlib from 'node:zlib'
import {
  AUTO_USER_API_INFO,
  BUILTIN_USER_APIS,
  BUILTIN_USER_API_IDS,
  USER_API_AUTO_ID,
  getBuiltinScript,
  toBuiltinInfo,
} from '@common/sources/builtin'
import { DEPRECATED_USER_API_IDS, isProtectedUserApiId } from '@common/sources/builtin/ids'

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

export const getUserApis = (): LX.UserApi.UserApiInfo[] => {
  if (userApis) return userApis

  const electronStore_userApi = getStore(STORE_NAMES.USER_API)
  let infoFull = electronStore_userApi.get('userApis') as LX.UserApi.UserApiInfoFull[]
  let requiredUpdate = false
  if (infoFull) {
    for (let i = 0; i < infoFull.length; i++) {
      const api = infoFull[i]
      if (api.version != null) continue
      requiredUpdate ||= true
      try {
        infoFull.splice(i, 1, {
          ...parseScriptInfo(api.script),
          ...api,
        })
      } catch (e) {
        infoFull.splice(i, 1)
        i--
      }
    }
  } else {
    infoFull = defaultUserApis
    electronStore_userApi.set('userApis', userApis)
  }
  userApis = infoFull.map(api => {
    if (api.allowShowUpdateAlert == null) api.allowShowUpdateAlert = false
    const { script, ...info } = api
    if (script) scripts.set(api.id, script)
    return info
  })
  if (requiredUpdate) saveData()
  ensureBuiltinUserApis()
  return userApis
}

const deflateScriptSync = (script: string) => {
  return 'gz_' + zlib.deflateSync(Buffer.from(script, 'utf8')).toString('base64')
}

/**
 * 启动时写入 7 个内置源，并插入虚拟项「自动切换」。
 * 脚本每次启动按固定 id 覆盖，用户自己导入的源留在后面。
 */
const ensureBuiltinUserApis = () => {
  if (!userApis) userApis = []
  for (const id of DEPRECATED_USER_API_IDS) scripts.delete(id)
  for (const api of BUILTIN_USER_APIS) {
    scripts.set(api.id, deflateScriptSync(api.script))
  }
  scripts.delete(USER_API_AUTO_ID)
  const builtinIds = new Set<string>(BUILTIN_USER_API_IDS)
  const deprecatedIds = new Set<string>(DEPRECATED_USER_API_IDS)
  const extras = userApis.filter(api => {
    return api.id !== USER_API_AUTO_ID && !builtinIds.has(api.id) && !deprecatedIds.has(api.id)
  })
  userApis = [
    AUTO_USER_API_INFO,
    ...BUILTIN_USER_APIS.map(toBuiltinInfo),
    ...extras,
  ]
  saveData()
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
  userApis ??= []
  for (const api of userApis) {
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
  userApis.push(apiInfo)
  scripts.set(apiInfo.id, script)
  saveData()
  return apiInfo
}

export const removeApi = (ids: string[]) => {
  if (!userApis) return
  for (let index = userApis.length - 1; index > -1; index--) {
    const id = userApis[index].id
    if (!ids.includes(id) || isProtectedUserApiId(id)) continue
    scripts.delete(id)
    userApis.splice(index, 1)
    ids.splice(index, 1)
  }
  saveData()
}

export const setAllowShowUpdateAlert = (id: string, enable: boolean) => {
  const targetApi = userApis?.find(api => api.id == id)
  if (!targetApi || isProtectedUserApiId(id)) return
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
  return getBuiltinScript(id)
}
