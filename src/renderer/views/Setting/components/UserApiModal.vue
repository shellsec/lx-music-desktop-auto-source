<template lang="pug">
material-modal(:show="modelValue" bg-close teleport="#view" @close="handleClose")
  main.scroll(:class="$style.main")
    h2 {{ $t('user_api__title') }}
    ul.scroll(v-if="apiList.length" :class="$style.content")
      li(v-for="(api, index) in apiList" :key="api.id" :class="[$style.listItem, {[$style.active]: appSetting['common.apiSource'] == api.id}]")
        div(:class="$style.listLeft")
          h3
            | {{ api.name }}
            span(v-if="api.version") {{ /^\d/.test(api.version) ? `v${api.version}` : api.version }}
            span(v-if="api.author") {{ api.author }}
          p {{ api.description }}
          div
            base-checkbox(:id="`user_api_${api.id}`" v-model="api.allowShowUpdateAlert" :class="$style.checkbox" :label="$t('user_api__allow_show_update_alert')" @change="handleChangeAllowUpdateAlert(api, $event)")
        base-btn(:disabled="index === 0" min @click="moveSource(index, -1)") 上移
        base-btn(:disabled="index === apiList.length - 1" min @click="moveSource(index, 1)") 下移
        base-btn(:class="$style.listBtn" outline :aria-label="$t('user_api__btn_remove')" @click.stop="handleRemove(index)")
          svg(v-once version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 212.982 212.982" space="preserve")
            use(xlink:href="#icon-delete")
    div(v-else :class="$style.content")
      div(:class="$style.noitem") {{ $t('user_api__noitem') }}
    div(:class="$style.note")
      input(v-model="subscriptionUrl" placeholder="https://example.com/sources.json" aria-label="源清单地址" @change="saveSubscriptionUrl")
      base-btn(min @click="saveSubscriptionUrl") 保存订阅地址
      base-btn(min @click="handleSubscriptionUpdate") 从源清单地址更新
      p 地址保存后重启保留；多源全部失败时自动检查订阅，自动检查间隔至少 60 秒。
    div(:class="$style.footer")
      base-btn(:class="$style.footerBtn" @click="isShowOnlineImportModal = true") {{ $t('user_api__btn_import_online') }}
      base-btn(:class="$style.footerBtn" @click="handleImport") {{ $t('user_api__btn_import') }}
      //- base-btn(:class="$style.footerBtn" @click="handleExport") {{ $t('user_api__btn_export') }}
    UserApiOnlineImportModal(v-model:show="isShowOnlineImportModal" @import="importUserApi")
</template>

<script>
import { importUserApi, removeUserApi, showSelectDialog, setAllowShowUserApiUpdateAlert, refreshUserApiSources, reorderUserApis } from '@renderer/utils/ipc'
import { readFile } from '@common/utils/nodejs'
import { setUserApi } from '@renderer/core/apiSource'
import apiSourceInfo from '@renderer/utils/musicSdk/api-source-info'
import { userApi } from '@renderer/store'
import { appSetting, updateSetting } from '@renderer/store/setting'
import { computed, ref } from '@common/utils/vueTools'
import { dialog } from '@renderer/plugins/Dialog'

import UserApiOnlineImportModal from './UserApiOnlineImportModal.vue'

export default {
  components: {
    UserApiOnlineImportModal,
  },
  props: {
    modelValue: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['update:modelValue'],
  setup() {
    const subscriptionUrl = ref(appSetting['common.sourceListUrl'])
    const isShowOnlineImportModal = ref(false)
    const apiList = computed(() => userApi.list)

    return {
      subscriptionUrl,
      userApi,
      apiList,
      appSetting,
      isShowOnlineImportModal,
    }
  },
  methods: {
    async moveSource(index, delta) {
      const ids = userApi.list.map(api => api.id)
      const target = index + delta
      if (target < 0 || target >= ids.length) return
      ;[ids[index], ids[target]] = [ids[target], ids[index]]
      userApi.list = await reorderUserApis(ids)
    },
    saveSubscriptionUrl() {
      this.subscriptionUrl = this.subscriptionUrl.trim()
      if (appSetting['common.sourceListUrl'] !== this.subscriptionUrl) {
        updateSetting({ 'common.sourceListUrl': this.subscriptionUrl })
      }
    },
    async handleSubscriptionUpdate() {
      this.saveSubscriptionUrl()
      const result = await refreshUserApiSources(this.subscriptionUrl.trim())
      userApi.list = result.list
      if (result.updated) {
        const id = appSetting['common.apiSource'] || result.list[0]?.id || ''
        updateSetting({ 'common.apiSource': id })
        await setUserApi(id, true)
      }
      await dialog(result.updated ? '源清单已更新' : '没有检测到更新，或清单暂时无法获取')
    },
    async importUserApi(script) {
      return importUserApi(script).then(({ apiList }) => {
        userApi.list = apiList
        if (!appSetting['common.apiSource']) updateSetting({ 'common.apiSource': apiList[0]?.id ?? '' })
      }).catch((err) => {
        void dialog(this.$t('user_api_import__failed', { message: err.message }))
      })
    },
    handleImport() {
      const customCount = this.userApi.list.length
      if (customCount > 20) {
        this.$dialog({
          message: this.$t('user_api__max_tip'),
          confirmButtonText: this.$t('ok'),
        })
        return
      }
      void showSelectDialog({
        title: this.$t('user_api__import_file'),
        properties: ['openFile'],
        filters: [
          { name: 'LX API File', extensions: ['js'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      }).then(async result => {
        if (result.canceled) return
        return readFile(result.filePaths[0]).then(async data => {
          return this.importUserApi(data.toString())
        })
      })
    },
    handleExport() {

    },
    async handleRemove(index) {
      const api = this.apiList[index]
      if (!api) return
      if (appSetting['common.apiSource'] == api.id) {
        let backApi = apiSourceInfo.find(api => !api.disabled)
        if (!backApi) backApi = userApi.list.find(item => item.id !== api.id)
        updateSetting({ 'common.apiSource': backApi?.id ?? '' })
      }
      userApi.list = await removeUserApi([api.id])
      if (!userApi.list.length) updateSetting({ 'common.apiSource': '' })
      await setUserApi(appSetting['common.apiSource'], true)
    },
    handleClose() {
      this.saveSubscriptionUrl()
      this.$emit('update:modelValue', false)
    },
    handleChangeAllowUpdateAlert(api, enable) {
      void setAllowShowUserApiUpdateAlert(api.id, enable)
    },
  },
}
</script>


<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.main {
  padding: 15px 8px;
  max-width: 550px;
  min-width: 300px;
  display: flex;
  flex-flow: column nowrap;
  min-height: 0;
  // max-height: 100%;
  // overflow: hidden;
  h2 {
    font-size: 16px;
    color: var(--color-font);
    line-height: 1.3;
    text-align: center;
  }
}

.name {
  color: var(--color-primary);
}

.checkbox {
  margin-top: 3px;
  font-size: 14px;
  opacity: .86;
}

.content {
  flex: auto;
  min-height: 80px;
  max-height: 100%;
  margin-top: 15px;
  padding: 0 7px;
}
.listItem {
  display: flex;
  flex-flow: row nowrap;
  align-items: center;
  transition: background-color 0.2s ease;
  padding: 15px 10px;
  border-radius: @radius-border;
  &:hover {
    background-color: var(--color-primary-background-hover);
  }
  &.active {
    background-color: var(--color-primary-background-active);
  }
  h3 {
    font-size: 15px;
    color: var(--color-font);
    word-break: break-all;
    span {
      font-size: 12px;
      color: var(--color-font-label);
      margin-left: 6px;
    }
  }
  p {
    margin-top: 5px;
    font-size: 14px;
    color: var(--color-font-label);
    word-break: break-all;
  }
}
.noitem {
  height: 100px;
  font-size: 18px;
  color: var(--color-font-label);
  display: flex;
  justify-content: center;
  align-items: center;
}
.listLeft {
  flex: auto;
  min-width: 0;
  display: flex;
  flex-flow: column nowrap;
  justify-content: center;
}
.listBtn {
  flex: none;
  height: 30px;
  width: 30px;
  padding: 0;
  display: flex;
  justify-content: center;
  align-items: center;
  svg {
    width: 60%;
  }
}
.note {
  padding: 0 7px;
  margin-top: 15px;
  font-size: 12px;
  line-height: 1.25;
  color: var(--color-font);
  p {
    + p {
      margin-top: 5px;
    }
  }
}
.footer {
  padding: 0 7px;
  margin-top: 15px;
  display: flex;
  flex-flow: row nowrap;
}
.footerBtn {
  flex: auto;
  height: 36px;
  line-height: 36px;
  padding: 0 10px !important;
  width: 150px;
  .mixin-ellipsis-1();
  + .footerBtn {
    margin-left: 15px;
  }
}
.ruleLink {
  .mixin-ellipsis-1();
}

</style>
