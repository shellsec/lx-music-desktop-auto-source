/** 内置自定义音源 id。渲染进程只引用这份清单，避免把脚本正文打进界面包。 */
export const USER_API_AUTO_ID = 'user_api_auto'

export const BUILTIN_USER_API_IDS = [
  'user_api_builtin_flower',
  'user_api_builtin_sixyin',
  'user_api_builtin_huibq',
  'user_api_builtin_ikun',
  'user_api_builtin_grass',
  'user_api_builtin_juhe',
  'user_api_builtin_qdy',
] as const

export const isBuiltinUserApiId = (id: string): boolean => {
  return (BUILTIN_USER_API_IDS as readonly string[]).includes(id)
}

export const isAutoOrBuiltinUserApiId = (id: string): boolean => {
  return id === USER_API_AUTO_ID || isBuiltinUserApiId(id)
}

/** 内置源和「自动切换」不允许删除，下次启动也会补回 */
export const isProtectedUserApiId = (id: string): boolean => {
  return isAutoOrBuiltinUserApiId(id)
}

export const DEPRECATED_USER_API_IDS = [
  'user_api_builtin_xinghai',
  'user_api_flower_builtin',
] as const
