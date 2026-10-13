import * as flower from './scripts/flower'
import * as sixyin from './scripts/sixyin'
import * as huibq from './scripts/huibq'
import * as ikun from './scripts/ikun'
import * as grass from './scripts/grass'
import * as juhe from './scripts/juhe'
import * as qdy from './scripts/qdy'
import { BUILTIN_USER_API_IDS, USER_API_AUTO_ID } from './ids'

export { BUILTIN_USER_API_IDS, USER_API_AUTO_ID } from './ids'

export interface BuiltinUserApi {
  key: string
  id: string
  name: string
  author: string
  version: string
  script: string
}

const ordered = [
  ['flower', flower],
  ['sixyin', sixyin],
  ['huibq', huibq],
  ['ikun', ikun],
  ['grass', grass],
  ['juhe', juhe],
  ['qdy', qdy],
] as const

export const BUILTIN_USER_APIS: BuiltinUserApi[] = ordered.map(([key, mod]) => ({
  key,
  id: mod.id,
  name: mod.name,
  author: mod.author,
  version: mod.version,
  script: mod.script,
}))

const builtinIds = BUILTIN_USER_APIS.map(api => api.id)
if (builtinIds.join() !== BUILTIN_USER_API_IDS.join()) {
  throw new Error(`builtin user api id mismatch: ${builtinIds.join()} != ${BUILTIN_USER_API_IDS.join()}`)
}

export const AUTO_USER_API_INFO: LX.UserApi.UserApiInfo = {
  id: USER_API_AUTO_ID,
  name: '自动切换',
  description: '按序尝试内置自定义音源解析播放地址',
  author: 'lx-music',
  homepage: '',
  version: '1',
  allowShowUpdateAlert: false,
}

export const toBuiltinInfo = (api: BuiltinUserApi): LX.UserApi.UserApiInfo => ({
  id: api.id,
  name: api.name,
  description: `内置 ${api.name}，用于解析播放地址`,
  author: api.author,
  homepage: '',
  version: api.version,
  allowShowUpdateAlert: false,
})

export const getBuiltinScript = (id: string) => BUILTIN_USER_APIS.find(api => api.id === id)?.script ?? ''
