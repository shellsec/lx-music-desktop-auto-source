/** Virtual selection; never persisted as a custom source. */
export const USER_API_AUTO_ID = 'user_api_auto'
export const isImportedUserApiId = (id: string): boolean => {
  return id.startsWith('user_api_') && id !== USER_API_AUTO_ID && !id.startsWith('user_api_builtin_')
}
export const isAutoUserApiId = (id: string): boolean => id === USER_API_AUTO_ID
