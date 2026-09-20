import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { CairnApi } from '@shared/types'

// The renderer gets a narrow, typed API - never ipcRenderer itself.

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: CairnApi = {
  collections: {
    list: () => invoke('collections:list'),
    create: (input) => invoke('collections:create', input),
    update: (id, patch) => invoke('collections:update', id, patch),
    move: (id, parentId, index) => invoke('collections:move', id, parentId, index),
    remove: (id) => invoke('collections:remove', id)
  },
  bookmarks: {
    query: (query) => invoke('bookmarks:query', query),
    get: (id) => invoke('bookmarks:get', id),
    findByUrl: (url) => invoke('bookmarks:findByUrl', url),
    create: (input) => invoke('bookmarks:create', input),
    createMany: (inputs) => invoke('bookmarks:createMany', inputs),
    update: (id, patch) => invoke('bookmarks:update', id, patch),
    bulk: (ids, patch) => invoke('bookmarks:bulk', ids, patch),
    trash: (ids) => invoke('bookmarks:trash', ids),
    restore: (ids) => invoke('bookmarks:restore', ids),
    purge: (ids) => invoke('bookmarks:purge', ids),
    emptyTrash: () => invoke('bookmarks:emptyTrash'),
    refreshMetadata: (id) => invoke('bookmarks:refreshMetadata', id)
  },
  tags: {
    list: () => invoke('tags:list'),
    rename: (from, to) => invoke('tags:rename', from, to),
    remove: (name) => invoke('tags:remove', name)
  },
  metadata: {
    fetch: (url) => invoke('metadata:fetch', url)
  },
  tools: {
    findDuplicates: () => invoke('tools:findDuplicates'),
    startJob: (kind) => invoke('tools:startJob', kind),
    cancelJob: (id) => invoke('tools:cancelJob', id)
  },
  data: {
    counts: () => invoke('data:counts'),
    importFile: () => invoke('data:import'),
    exportFile: (format) => invoke('data:export', format)
  },
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch)
  },
  app: {
    version: () => invoke('app:version'),
    platform: process.platform,
    openExternal: (url) => invoke('app:openExternal', url),
    copyText: (text) => invoke('app:copyText', text),
    showLegal: () => invoke('app:showLegal')
  },
  on: {
    menuAction: (cb) => subscribe('menu:action', cb),
    jobProgress: (cb) => subscribe('job:progress', cb),
    settingsChanged: (cb) => subscribe<null>('settings:changed', () => cb())
  }
}

contextBridge.exposeInMainWorld('cairn', api)
