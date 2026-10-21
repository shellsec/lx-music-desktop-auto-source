const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function loader(mocks = {}) {
  const cache = new Map()
  function load(file) {
    file = path.resolve(file)
    if (cache.has(file)) return cache.get(file).exports
    const mod = { exports: {} }
    cache.set(file, mod)
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText
    const localRequire = id => {
      if (Object.hasOwn(mocks, id)) return mocks[id]
      if (id.startsWith('@common/')) return load(`src/common/${id.slice(8)}.ts`)
      if (id.startsWith('.')) return load(path.resolve(path.dirname(file), id + '.ts'))
      return require(id)
    }
    new Function('require', 'module', 'exports', code)(localRequire, mod, mod.exports)
    return mod.exports
  }
  return load
}
function storage(stored) {
  const data = {userApis: stored}
  const store = { get: key => data[key], set: (key, value) => { data[key] = value } }
  const load = () => loader({ '@common/constants': { STORE_NAMES: { USER_API: 'test' } }, '@main/utils/store': () => store })('src/main/modules/userApi/utils.ts')
  const api = load()
  api.reload = load
  return api
}
const script = '/*!\n * @name Local Test\n * @version 1\n */\nglobalThis.lx.send(globalThis.lx.EVENT_NAMES.inited, { status: true, sources: {} })'

test('fresh installation has no custom sources; switching and subscription are off', () => {
  assert.deepEqual(storage(undefined).getUserApis(), [])
  assert.deepEqual(storage([]).getUserApis(), [])
  const defaults = fs.readFileSync('src/common/defaultSetting.ts', 'utf8')
  assert.match(defaults, /'common.apiSource': ''/)
  assert.match(defaults, /'common.sourceListUrl': ''/)
})
test('local import survives reload; removal, duplicate checking and persisted ordering work', async() => {
  const apis = storage(undefined)
  const first = await apis.importApi(script)
  const second = await apis.importApi(script.replace('Local Test', 'Second Test'))
  assert.equal(await apis.getScript(first.id), script)
  await assert.rejects(apis.importApi(script))
  assert.deepEqual(apis.reorderApis([second.id, first.id]).map(x => x.id), [second.id, first.id])
  assert.throws(() => apis.reorderApis([first.id, first.id]))
  apis.removeApi([first.id, second.id])
  assert.deepEqual(apis.getUserApis(), [])
})
test('upgrading removes previously bundled and virtual entries, preserves imports', () => {
  const apis = storage([{ id: 'user_api_builtin_legacy', script }, { id: 'user_api_auto' }, { id: 'user_api_local', name: 'Local', script }])
  assert.deepEqual(apis.getUserApis().map(x => x.id), ['user_api_local'])
})
test('subscription validates both formats and preserves imports and ordering', async() => {
  const { parseRemoteSources } = loader()('src/common/sources/user/failover.ts')
  const rows = [{ id: 'test', name: 'Test', url: 'https://example.com/test.js' }]
  assert.deepEqual(parseRemoteSources(rows), rows)
  assert.deepEqual(parseRemoteSources({ sources: rows }), rows)
  assert.equal(parseRemoteSources({ sources: [rows[0], rows[0]] }), null)
  assert.equal(parseRemoteSources([{ ...rows[0], url: 'http://example.com/test.js' }]), null)
  const apis = storage(undefined)
  const local = await apis.importApi(script)
  apis.applyRemoteSources([{ ...rows[0], script }])
  apis.applyRemoteSources([{ ...rows[0], script: script.replace('Local Test', 'Updated') }])
  assert.deepEqual(apis.getUserApis().map(x => x.id), [local.id, 'user_api_subscription_test'])
})
test('failover is ordered, bounded, stops on success and cancels on selection change', async() => {
  const { runUserApiFailover } = loader()('src/common/sources/user/failover.ts')
  const tried = []
  const result = await runUserApiFailover({ loadOrder: () => ['a', 'b', 'c'], tryId: async id => { tried.push(id); if (id !== 'b') throw Error('failed'); return 'ok' }, onGiveUp: () => assert.fail() })
  assert.equal(result, 'ok')
  assert.deepEqual(tried, ['a', 'b'])
  let ended = 0
  tried.length = 0
  await assert.rejects(runUserApiFailover({ loadOrder: () => ['a', 'a', 'b'], tryId: async id => { tried.push(id); throw Error('failed') }, onGiveUp: () => ended++ }))
  assert.deepEqual(tried, ['a', 'b'])
  assert.equal(ended, 1)
  await assert.rejects(runUserApiFailover({ loadOrder: () => ['a', 'b'], tryId: async() => { throw Error('source changed') }, onGiveUp: () => assert.fail() }), /source changed/)
})

test('imported local test script initializes and resolves a playback request', async() => {
  const vm = require('node:vm')
  const apis = storage(undefined)
  const source = `/*!\n * @name Local Playback Test\n */
    lx.on(lx.EVENT_NAMES.request, ({action}) => {
      if (action !== 'musicUrl') throw Error('unsupported')
      return Promise.resolve('http://127.0.0.1:19090/test.wav')
    })
    lx.send(lx.EVENT_NAMES.inited, {status: true, sources: {kw: {type: 'music', actions: ['musicUrl'], qualitys: ['128k']}}})`
  const imported = await apis.importApi(source)
  const handlers = new Map()
  let ready
  vm.runInNewContext(await apis.getScript(imported.id), {lx: {
    EVENT_NAMES: {request: 'request', inited: 'inited'},
    on: (name, handler) => handlers.set(name, handler),
    send: (_name, value) => { ready = value },
  }})
  assert.equal(ready.status, true)
  assert.equal(await handlers.get('request')({ action: 'musicUrl' }), 'http://127.0.0.1:19090/test.wav')
})
test('blank subscription performs no network request; invalid downloads preserve local imports', async() => {
  const apis = storage(undefined)
  const imported = await apis.importApi(script)
  let calls = 0
  let response = { sources: [{ id: 'test', name: 'Test', url: 'https://example.com/test.js' }] }
  const remote = loader({
    '@common/utils/request': { request: async() => { calls++; return { statusCode: 200, body: calls === 1 ? response : 'invalid script' } } },
    './utils': apis,
  })('src/main/modules/userApi/remoteCatalog.ts')
  assert.equal((await remote.refreshUserApisFromRemote('')).updated, false)
  assert.equal(calls, 0)
  assert.equal((await remote.refreshUserApisFromRemote('https://example.com/sources.json')).updated, false)
  assert.equal(calls, 2)
  assert.deepEqual(apis.getUserApis().map(x => x.id), [imported.id])
})

test('renderer retries only imported IDs in user order and leaves manual mode disabled', async() => {
  const userApi = { list: [{id: 'user_api_first'}, {id: 'user_api_second'}, {id: 'user_api_third'}], status: false, apis: {} }
  const appSetting = {'common.apiSource': 'user_api_auto'}
  const loaded = []
  const oldWindow = global.window
  global.window = {lx: {apiInitPromise: [Promise.resolve(false), true, () => {}]}}
  try {
    const failover = loader({
      '@renderer/store': {userApi, apiSource: {value: 'user_api_auto'}, qualityList: {value: {}}},
      '@renderer/store/setting': {appSetting},
      '@renderer/utils/ipc': {setUserApi: async id => {
        loaded.push(id)
        userApi.status = true
        userApi.apis = {kw: {}}
        global.window.lx.apiInitPromise[2](true)
      }},
    })('src/renderer/core/userApiFailover.ts')
    assert.deepEqual(failover.getImportedUserApiIds(), userApi.list.map(x => x.id))
    await failover.activateAutoUserApi()
    assert.deepEqual(loaded, ['user_api_first'])
    const result = await failover.tryUserApiMusicUrlFailover(async() => {
      if (loaded.at(-1) === 'user_api_second') throw Error('failed')
      return {url: 'http://127.0.0.1:19090/test.wav', type: '128k'}
    })
    assert.equal(result.type, '128k')
    assert.deepEqual(loaded, ['user_api_first', 'user_api_second', 'user_api_third'])
    await assert.rejects(failover.tryUserApiMusicUrlFailover(async() => assert.fail()))
    assert.deepEqual(loaded, ['user_api_first', 'user_api_second', 'user_api_third'])
    appSetting['common.apiSource'] = 'user_api_first'
    assert.equal(failover.isAutoUserApiSource(), false)
    await assert.rejects(failover.tryUserApiMusicUrlFailover(async() => assert.fail()), /not auto mode/)
    await assert.rejects(failover.loadImportedUserApi('user_api_unknown'), /source not imported/)
    userApi.list = []
    assert.deepEqual(failover.getImportedUserApiIds(), [])
  } finally { global.window = oldWindow }
})

test('failed media sources stay excluded for the same song and reset for a new song', () => {
  const state = loader()('src/common/sources/user/failover.ts')
  state.notePlayingSong('kw:first')
  state.markSourceFailed('user_api_first')
  state.notePlayingSong('kw:first')
  assert.equal(state.hasSourceFailed('user_api_first'), true)
  state.notePlayingSong('kw:second')
  assert.equal(state.hasSourceFailed('user_api_first'), false)
})
test('distribution check rejects a custom source payload', () => {
  const os = require('node:os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-distribution-test-'))
  try {
    fs.writeFileSync(path.join(dir, 'main.js'), 'console.log("runtime")')
    require('../build-config/check-source-resources')(dir)
    fs.writeFileSync(path.join(dir, 'test.js'), script)
    assert.throws(() => require('../build-config/check-source-resources')(dir), /Custom source script/)
  } finally { fs.rmSync(dir, {recursive: true, force: true}) }
})

test('empty-source playback rejects with the import hint; expired media advances to failover', async() => {
  const userApi = {list: [], apis: {}}
  let automatic = false
  let directCalls = 0
  let failoverCalls = 0
  const oldWindow = global.window
  global.window = {lx: {apiInitPromise: [Promise.resolve(true), true, () => {}]}}
  try {
    const music = loader({
      '@renderer/store': {userApi, qualityList: {value: {kw: ['128k']}}},
      '@renderer/store/utils': {assertApiSupport: () => true},
      '@renderer/store/setting': {appSetting: {'player.playQuality': '128k'}},
      '@renderer/utils/musicSdk': {kw: {getMusicUrl: () => {directCalls++; return {promise: Promise.resolve({url: 'http://127.0.0.1/old.wav', type: '128k'})}}}},
      '@renderer/utils/ipc': {},
      '@renderer/utils': {toOldMusicInfo: x => x},
      '@renderer/utils/message': {requestMsg: {}},
      '@renderer/utils/musicSdk/api-source': {},
      '@renderer/core/userApiFailover': {
        isAutoUserApiSource: () => automatic,
        getLoadedUserApiId: () => 'user_api_first',
        tryUserApiMusicUrlFailover: async() => {failoverCalls++; return {url: 'http://127.0.0.1/new.wav', type: '128k'}},
      },
    })('src/renderer/core/music/utils.ts')
    const args = {musicInfo: {id: 'test', source: 'kw', meta: {_qualitys: {'128k': {}}}}, isRefresh: false, allowToggleSource: true, onToggleSource: () => {}}
    await assert.rejects(music.handleGetOnlineMusicUrl(args), /请在设置中导入自定义源/)
    assert.equal(directCalls, 0)
    userApi.list = [{id: 'user_api_first'}]
    assert.equal((await music.handleGetOnlineMusicUrl(args)).url, 'http://127.0.0.1/old.wav')
    automatic = true
    assert.equal((await music.handleGetOnlineMusicUrl({...args, isRefresh: true})).url, 'http://127.0.0.1/new.wav')
    assert.equal(failoverCalls, 1)
    assert.equal(directCalls, 1)
  } finally { global.window = oldWindow }
})

test('subscription snapshots distinguish identical content, script updates and catalog changes after restart', async() => {
  let apis = storage(undefined)
  const local = await apis.importApi(script)
  const refs = [{id: 'test', name: 'Test', url: 'https://example.com/test.js', script}]
  apis.applyRemoteSources(refs)
  apis = apis.reload()
  assert.equal(await apis.hasRemoteSourceChanges(refs), false)
  assert.equal(await apis.hasRemoteSourceChanges([{...refs[0], script: script + '\n// changed'}]), true)
  assert.equal(await apis.hasRemoteSourceChanges([{...refs[0], name: 'Renamed'}]), true)
  const second = {...refs[0], id: 'second'}
  apis.applyRemoteSources([...refs, second])
  apis.reorderApis(['user_api_subscription_second', local.id, 'user_api_subscription_test'])
  assert.equal(await apis.hasRemoteSourceChanges([...refs, second]), false)
  assert.equal(await apis.hasRemoteSourceChanges([second, ...refs]), true)
  apis.applyRemoteSources([second])
  assert.deepEqual(apis.getUserApis().map(x => x.id), ['user_api_subscription_second', local.id])
})
test('unchanged remote content is not applied again; same script URL with changed content updates', async() => {
  const apis = storage(undefined)
  let body = script
  let applyCount = 0
  const remote = loader({
    '@common/utils/request': {request: async url => ({statusCode: 200, body: url.endsWith('.json') ? [{id: 'test', name: 'Test', url: 'https://example.com/test.js'}] : body})},
    './utils': {...apis, applyRemoteSources: refs => {applyCount++; return apis.applyRemoteSources(refs)}},
  })('src/main/modules/userApi/remoteCatalog.ts')
  assert.equal((await remote.refreshUserApisFromRemote('https://example.com/sources.json')).updated, true)
  assert.equal((await remote.refreshUserApisFromRemote('https://example.com/sources.json')).updated, false)
  assert.equal(applyCount, 1)
  body += '\n// new content'
  assert.equal((await remote.refreshUserApisFromRemote('https://example.com/sources.json')).updated, true)
  assert.equal(applyCount, 2)
})
test('all sources fail before a single subscription check, then at most one complete extra round', async() => {
  const state = loader()('src/common/sources/user/failover.ts')
  state.notePlayingSong('kw:remote-test')
  const order = []
  let checks = 0
  let round = 1
  const opts = {
    subscriptionUrl: 'https://example.com/sources.json',
    loadOrder: () => ['a', 'b'].filter(id => !state.hasSourceFailed(id)),
    tryId: async id => {order.push(`${round}:${id}`); state.markSourceFailed(id); throw Error('failed')},
    refresh: async() => {checks++; order.push('remote'); round++; return {updated: true}},
    onGiveUp: () => {},
  }
  await assert.rejects(state.runUserApiFailover(opts))
  assert.deepEqual(order, ['1:a', '1:b', 'remote', '2:a', '2:b'])
  await assert.rejects(state.runUserApiFailover(opts))
  assert.equal(checks, 1)
  assert.equal(order.length, 5)
})
test('unchanged or failed subscription never enables a second round or repeated requests', async() => {
  for (const response of [false, 'error']) {
    const state = loader()('src/common/sources/user/failover.ts')
    state.notePlayingSong('kw:unchanged')
    let checks = 0
    let attempts = 0
    const opts = {
      subscriptionUrl: 'https://example.com/sources.json',
      loadOrder: () => ['a'].filter(id => !state.hasSourceFailed(id)),
      tryId: async id => {attempts++; state.markSourceFailed(id); throw Error('failed')},
      refresh: async() => {checks++; if (response === 'error') throw Error('network'); return {updated: false}},
      onGiveUp: () => {},
    }
    await assert.rejects(state.runUserApiFailover(opts))
    await assert.rejects(state.runUserApiFailover(opts))
    assert.equal(checks, 1)
    assert.equal(attempts, 1)
  }
})
test('automatic checks are limited per song and by a 60-second cooldown; changed URLs can be checked', () => {
  const state = loader()('src/common/sources/user/failover.ts')
  const url = 'https://example.com/sources.json'
  state.notePlayingSong('kw:first')
  assert.equal(state.claimSubscriptionCheck(url, 1000), true)
  assert.equal(state.claimSubscriptionCheck(url, 62000), false)
  state.notePlayingSong('kw:second')
  assert.equal(state.claimSubscriptionCheck(url, 2000), false)
  assert.equal(state.claimSubscriptionCheck(url, 61000), true)
  assert.equal(state.claimSubscriptionCheck('https://example.com/other.json', 61001), true)
  assert.equal(state.claimSubscriptionCheck('', 61002), false)
})
test('concurrent failures share the subscription check; stale songs never replay updated sources', async() => {
  const state = loader()('src/common/sources/user/failover.ts')
  state.notePlayingSong('kw:old')
  let complete
  let checks = 0
  let attempts = 0
  const opts = {subscriptionUrl: 'https://example.com/sources.json', loadOrder: () => [], tryId: async() => {attempts++}, refresh: () => {checks++; return new Promise(resolve => {complete = resolve})}, onGiveUp: () => {}}
  const first = state.runUserApiFailover(opts)
  const firstRejected = assert.rejects(first, /source changed/)
  await Promise.resolve()
  await Promise.resolve()
  await assert.rejects(state.runUserApiFailover(opts))
  assert.equal(checks, 1)
  state.notePlayingSong('kw:new')
  complete({updated: true})
  await firstRejected
  assert.equal(attempts, 0)
})

test('the last media-load failure still enters the subscription failover path', () => {
  const listeners = new Map()
  let retries = 0
  const oldWindow = global.window
  global.window = {lx: {isPlayedStop: false}, app_event: {on: (key, fn) => listeners.set(key, fn), off: () => {}}}
  try {
    const init = loader({
      '@common/utils/vueTools': {onBeforeUnmount: () => {}},
      '@renderer/plugins/i18n': {useI18n: () => key => key},
      '@renderer/store/player/state': {musicInfo: {id: 'test'}, playMusicInfo: {musicInfo: {id: 'test'}}},
      '@renderer/plugins/player': {setStop: () => {}, isEmpty: () => true},
      '@renderer/core/player': {playNext: () => {}, setMusicUrl: () => {retries++}},
      '@renderer/store/player/action': {setAllStatus: () => {}},
      '@renderer/store/setting': {appSetting: {'player.autoSkipOnError': false}},
      '@renderer/store': {userApi: {list: [{id: 'user_api_first'}]}},
      '@renderer/core/userApiFailover': {isAutoUserApiSource: () => true},
    })('src/renderer/core/useApp/usePlayer/usePlayEvent.ts').default
    init()
    listeners.get('playerError')(2)
    assert.equal(retries, 1)
  } finally {global.window = oldWindow}
})

test('renderer uses the saved subscription, reloads changed scripts and never refreshes twice for one song', async() => {
  const userApi = {list: [{id: 'user_api_first'}, {id: 'user_api_second'}], status: false, apis: {}}
  const url = 'https://example.com/sources.json'
  const appSetting = {'common.apiSource': 'user_api_auto', 'common.sourceListUrl': url}
  const oldWindow = global.window
  global.window = {lx: {apiInitPromise: [Promise.resolve(false), true, () => {}]}}
  let version = 1
  let requests = 0
  const loaded = []
  try {
    const load = loader({
      '@renderer/store': {userApi, apiSource: {value: 'user_api_auto'}, qualityList: {value: {}}},
      '@renderer/store/setting': {appSetting},
      '@renderer/utils/ipc': {
        setUserApi: async id => {loaded.push(`${version}:${id}`); userApi.status = true; userApi.apis = {kw: {}}; global.window.lx.apiInitPromise[2](true)},
        refreshUserApiSources: async address => {assert.equal(address, url); requests++; version = 2; return {updated: true, list: [...userApi.list]}},
      },
    })
    load('src/common/sources/user/failover.ts').notePlayingSong('kw:saved-url')
    const failover = load('src/renderer/core/userApiFailover.ts')
    await failover.activateAutoUserApi()
    const result = await failover.tryUserApiMusicUrlFailover(async() => {
      if (version === 1) throw Error('old script failed')
      return {url: 'http://127.0.0.1/test.wav', type: '128k'}
    })
    assert.equal(result.type, '128k')
    assert.deepEqual(loaded, ['1:user_api_first', '1:user_api_second', '2:user_api_first'])
    await assert.rejects(failover.tryUserApiMusicUrlFailover(async() => {throw Error('media failed')}))
    assert.equal(requests, 1)
    assert.deepEqual(loaded, ['1:user_api_first', '1:user_api_second', '2:user_api_first', '2:user_api_second'])
  } finally {global.window = oldWindow}
})
test('subscription address saves without fetching, survives closing and is restored on reopening', () => {
  const settings = {'common.sourceListUrl': ''}
  const saved = []
  const component = {exports: {}}
  const code = fs.readFileSync('src/renderer/views/Setting/components/UserApiModal.vue', 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1]
  const compiled = ts.transpileModule(code, {compilerOptions: {module: ts.ModuleKind.CommonJS, esModuleInterop: true}}).outputText
  const mocks = {
    '@renderer/utils/ipc': {refreshUserApiSources: () => assert.fail('saving must not fetch')},
    '@common/utils/nodejs': {}, '@renderer/core/apiSource': {},
    '@renderer/utils/musicSdk/api-source-info': [], '@renderer/store': {userApi: {list: []}},
    '@renderer/store/setting': {appSetting: settings, updateSetting: value => {saved.push({...value}); Object.assign(settings, value)}},
    '@common/utils/vueTools': {ref: value => ({value}), computed: get => ({get value() {return get()}})},
    '@renderer/plugins/Dialog': {}, './UserApiOnlineImportModal.vue': {},
  }
  new Function('require', 'module', 'exports', compiled)(id => {assert.ok(Object.hasOwn(mocks, id), id); return mocks[id]}, component, component.exports)
  const options = component.exports.default
  const ctx = {subscriptionUrl: '  https://example.com/sources.json  ', $emit: () => {}}
  ctx.saveSubscriptionUrl = options.methods.saveSubscriptionUrl.bind(ctx)
  options.methods.handleClose.call(ctx)
  assert.equal(settings['common.sourceListUrl'], 'https://example.com/sources.json')
  assert.equal(options.setup().subscriptionUrl.value, 'https://example.com/sources.json')
  ctx.saveSubscriptionUrl()
  assert.equal(saved.length, 1)
  ctx.subscriptionUrl = ''
  ctx.saveSubscriptionUrl()
  assert.equal(options.setup().subscriptionUrl.value, '')
})

test('release and application updates target this fork and preserve upstream author credit', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  assert.equal(pkg.author.name, 'lyswhut')
  assert.equal(pkg.repository.url, 'git+https://github.com/shellsec/lx-music-desktop-auto-source.git')
  const config = fs.readFileSync('build-config/build-pack.js', 'utf8')
  assert.match(config, /owner: 'shellsec'/)
  assert.match(config, /repo: 'lx-music-desktop-auto-source'/)
  const updater = fs.readFileSync('src/renderer/utils/update.js', 'utf8')
  assert.doesNotMatch(updater, /registry\.npmjs|registry\.npmmirror|gitee\.com\/lyswhut|cdn\.stsky/)
})
