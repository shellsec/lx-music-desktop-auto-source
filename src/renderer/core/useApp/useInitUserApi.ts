import { onBeforeUnmount, watch } from '@common/utils/vueTools'
import { useI18n } from '@renderer/plugins/i18n'
import { onUserApiStatus, getUserApiList, sendUserApiRequest as sendUserApiRequestRemote, userApiRequestCancel, onShowUserApiUpdateAlert } from '@renderer/utils/ipc'
import { openUrl } from '@common/utils/electron'
import { qualityList, userApi } from '@renderer/store'
import { appSetting } from '@renderer/store/setting'
import { dialog } from '@renderer/plugins/Dialog'
import { setUserApi } from '@renderer/core/apiSource'
import apiSourceInfo from '@renderer/utils/musicSdk/api-source-info'
import { USER_API_AUTO_ID, isImportedUserApiId } from '@common/sources/user/ids'
import { getExpectedLoadId, isUserApiFailoverRunning, setLoadedUserApiId } from '@renderer/core/userApiFailover'

const sendUserApiRequest: typeof sendUserApiRequestRemote = async(data) => {
  let stop: () => void
  return new Promise<void>((resolve, reject) => {
    stop = watch(() => appSetting['common.apiSource'], () => {
      reject(new Error('source changed'))
    })
    void sendUserApiRequestRemote(data).then(resolve).catch(reject)
  }).finally(() => {
    stop()
  })
}

export default () => {
  const t = useI18n()

  const rUserApiStatus = onUserApiStatus(({ params: { status, message, apiInfo } }) => {
    // console.log({ status, message, apiInfo })
    const expectedId = getExpectedLoadId()
    if (expectedId && apiInfo?.id !== expectedId) return

    const settingId = appSetting['common.apiSource']
    // 设置记成自动时，实际 load 的是某个导入源 id。手动选中某个导入源后换源，也要认新的导入源 id。
    const matched = !!apiInfo && (
      apiInfo.id === settingId ||
      (isImportedUserApiId(apiInfo.id) && settingId === USER_API_AUTO_ID)
    )
    if (!matched || !apiInfo) return
    userApi.status = status
    userApi.message = message
    if (status) {
      if (isImportedUserApiId(apiInfo.id)) setLoadedUserApiId(apiInfo.id)
      if (apiInfo.sources) {
        let apis: any = {}
        let qualitys: LX.QualityList = {}
        for (const [source, { actions, type, qualitys: sourceQualitys }] of Object.entries(apiInfo.sources)) {
          if (type != 'music') continue
          apis[source as LX.Source] = {}
          for (const action of actions) {
            switch (action) {
              case 'musicUrl':
                apis[source].getMusicUrl = (songInfo: LX.Music.MusicInfo, type: LX.Quality) => {
                  const requestKey = `request__${Math.random().toString().substring(2)}`
                  return {
                    canceleFn() {
                      userApiRequestCancel(requestKey)
                    },
                    promise: sendUserApiRequest({
                      requestKey,
                      data: {
                        source,
                        action: 'musicUrl',
                        info: {
                          type,
                          musicInfo: songInfo,
                        },
                      },
                      // eslint-disable-next-line @typescript-eslint/promise-function-async
                    }).then(res => {
                      // console.log(res)
                      return { type, url: res.data.url }
                    }).catch(async err => {
                      console.log(err.message)
                      return Promise.reject(err)
                    }),
                  }
                }
                break
              case 'lyric':
                apis[source].getLyric = (songInfo: LX.Music.MusicInfo) => {
                  const requestKey = `request__${Math.random().toString().substring(2)}`
                  return {
                    canceleFn() {
                      userApiRequestCancel(requestKey)
                    },
                    promise: sendUserApiRequest({
                      requestKey,
                      data: {
                        source,
                        action: 'lyric',
                        info: {
                          type,
                          musicInfo: songInfo,
                        },
                      },
                      // eslint-disable-next-line @typescript-eslint/promise-function-async
                    }).then(res => {
                      // console.log(res)
                      return res.data
                    }).catch(async err => {
                      console.log(err.message)
                      return Promise.reject(err)
                    }),
                  }
                }
                break
              case 'pic':
                apis[source].getPic = (songInfo: LX.Music.MusicInfo) => {
                  const requestKey = `request__${Math.random().toString().substring(2)}`
                  return {
                    canceleFn() {
                      userApiRequestCancel(requestKey)
                    },
                    promise: sendUserApiRequest({
                      requestKey,
                      data: {
                        source,
                        action: 'pic',
                        info: {
                          type,
                          musicInfo: songInfo,
                        },
                      },
                      // eslint-disable-next-line @typescript-eslint/promise-function-async
                    }).then(res => {
                      // console.log(res)
                      return res.data
                    }).catch(async err => {
                      console.log(err.message)
                      return Promise.reject(err)
                    }),
                  }
                }
                break
              default:
                break
            }
          }
          qualitys[source as LX.Source] = sourceQualitys
        }
        qualityList.value = qualitys
        userApi.apis = apis
      }
    } else if (message && !isUserApiFailoverRunning()) {
      void dialog({
        message: `${t('user_api__init_failed_alert', { name: apiInfo.name })}\n${message}`,
        selection: true,
        confirmButtonText: t('ok'),
      })
    }
    if (!window.lx.apiInitPromise[1]) window.lx.apiInitPromise[2](status)
  })

  const rUserApiShowUpdateAlert = onShowUserApiUpdateAlert(({ params: { name, log, updateUrl } }) => {
    if (updateUrl) {
      void dialog({
        message: `${t('user_api__update_alert', { name })}\n${log}`,
        selection: true,
        showCancel: true,
        confirmButtonText: t('user_api__update_alert_open_url'),
        cancelButtonText: t('close'),
      }).then(confirm => {
        if (!confirm) return
        window.setTimeout(() => {
          void openUrl(updateUrl)
        }, 300)
      })
    } else {
      void dialog({
        message: `${t('user_api__update_alert', { name })}\n${log}`,
        selection: true,
        confirmButtonText: t('ok'),
      })
    }
  })

  onBeforeUnmount(() => {
    rUserApiStatus()
    rUserApiShowUpdateAlert()
  })

  return async() => {
    let list: LX.UserApi.UserApiInfo[] = []
    try {
      list = await getUserApiList()
      userApi.list = list
    } catch (err) {
      console.log(err)
    }
    const settingId = appSetting['common.apiSource']
    const knownIds = new Set<string>([
      ...apiSourceInfo.filter(api => !api.disabled).map(api => api.id),
      ...list.map(api => api.id),
    ])
    const apiId = settingId === USER_API_AUTO_ID && list.length
      ? USER_API_AUTO_ID
      : knownIds.has(settingId) ? settingId : list[0]?.id ?? ''
    await setUserApi(apiId)
  }
}
