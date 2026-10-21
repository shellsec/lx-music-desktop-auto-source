import { apiSource, userApi } from '@renderer/store'

const supportQuality = {}
const apis = source => {
  if (!userApi.list.length) throw new Error('请在设置中导入自定义源')
  if (!/^user_api/.test(apiSource.value)) throw new Error('请在设置中导入自定义源')
  const api = userApi.apis[source]
  if (!api) throw new Error('当前自定义源不支持此平台')
  return api
}

export { apis, supportQuality }
