export interface RemoteSourceRef {
  id: string
  name: string
  url: string
}

export interface RemoteSourceScript extends RemoteSourceRef {
  script: string
}

const REMOTE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export const parseRemoteSources = (payload: unknown): RemoteSourceRef[] | null => {
  const data = typeof payload === 'string'
    ? safeJson(payload)
    : payload
  if (!data || typeof data !== 'object') return null
  const sources = Array.isArray(data) ? data : (data as { sources?: unknown }).sources
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > 40) return null
  const seen = new Set<string>()
  const list: RemoteSourceRef[] = []
  for (const item of sources) {
    if (!item || typeof item !== 'object') return null
    const row = item as { id?: unknown, name?: unknown, url?: unknown }
    if (typeof row.id !== 'string' || !REMOTE_ID_RE.test(row.id)) return null
    if (typeof row.name !== 'string' || !row.name.trim() || row.name.trim().length > 80) return null
    if (typeof row.url !== 'string' || !/^https:\/\/.{1,2000}$/.test(row.url)) return null
    if (seen.has(row.id)) return null
    seen.add(row.id)
    list.push({ id: row.id, name: row.name.trim(), url: row.url })
  }
  return list
}

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

export const isUserApiScriptText = (script: string) => {
  return script.length > 0 &&
    script.length < 9_000_000 &&
    /^\/\*[\s\S]+?\*\//.test(script) &&
    /@name\s+\S/.test(script)
}

export interface PlayingSong {
  id?: string
  source?: string
  metadata?: {
    musicInfo?: {
      id?: string
      source?: string
    }
  }
}

export const songKeyOf = (musicInfo: PlayingSong | null | undefined): string => {
  if (!musicInfo) return ''
  const inner = musicInfo.metadata?.musicInfo
  if (inner?.id) return `${inner.source ?? ''}:${inner.id}`
  if (!musicInfo.id) return ''
  return `${musicInfo.source ?? ''}:${musicInfo.id}`
}

let currentSongKey = ''
const failedSourceIds = new Set<string>()
const checkedSubscriptions = new Set<string>()
const lastSubscriptionChecks = new Map<string, number>()
export const getPlayingSongKey = () => currentSongKey
export const notePlayingSong = (songKey: string) => {
  if (currentSongKey === songKey) return
  currentSongKey = songKey
  failedSourceIds.clear()
  checkedSubscriptions.clear()
}
export const markSourceFailed = (id: string) => { failedSourceIds.add(id) }
export const hasSourceFailed = (id: string) => failedSourceIds.has(id)

/** Automatic checks are single-use for this song and rate-limited across songs. */
export const claimSubscriptionCheck = (address: string, now = Date.now()): boolean => {
  const url = address.trim()
  if (!url || !/^https:\/\//i.test(url) || checkedSubscriptions.has(url)) return false
  const previous = lastSubscriptionChecks.get(url)
  if (previous != null && now - previous < 60_000) return false
  checkedSubscriptions.add(url)
  lastSubscriptionChecks.set(url, now)
  return true
}

/** One local round, then one updated-subscription round at most. */
export const runUserApiFailover = async <T>(opts: {
  loadOrder: () => string[]
  tryId: (id: string) => Promise<T>
  subscriptionUrl?: string
  refresh?: () => Promise<{ updated: boolean }>
  isCurrent?: () => boolean
  onGiveUp: () => void
}): Promise<T> => {
  const songKey = currentSongKey
  const assertCurrent = () => {
    if (songKey !== currentSongKey || opts.isCurrent?.() === false) throw new Error('source changed')
  }
  const isSourceChanged = (err: unknown) => err instanceof Error && err.message === 'source changed'
  let lastError: unknown = new Error('all imported sources failed')
  const tryOrder = async(): Promise<T> => {
    assertCurrent()
    for (const id of [...new Set(opts.loadOrder())]) {
      assertCurrent()
      try {
        const result = await opts.tryId(id)
        assertCurrent()
        return result
      } catch (err) {
        if (isSourceChanged(err)) throw err
        lastError = err
      }
    }
    throw lastError
  }
  try {
    return await tryOrder()
  } catch (err) {
    if (isSourceChanged(err)) throw err
  }
  assertCurrent()
  if (opts.refresh && claimSubscriptionCheck(opts.subscriptionUrl ?? '')) {
    let updated = false
    try {
      updated = (await opts.refresh()).updated
    } catch (err) {
      if (isSourceChanged(err)) throw err
    }
    assertCurrent()
    if (updated) {
      failedSourceIds.clear()
      try {
        return await tryOrder()
      } catch (err) {
        if (isSourceChanged(err)) throw err
      }
    }
  }
  opts.onGiveUp()
  throw lastError
}
