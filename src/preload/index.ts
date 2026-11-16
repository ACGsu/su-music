import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS } from '../shared/contracts.ts'
import type { AppState, DesktopAPI, Preferences } from '../shared/contracts.ts'
import type { CandidateId, OnlineSearchRequest, TrackReference } from '../shared/music.ts'
import type { MediaEvent, PlayerCommand, PlayerState } from '../shared/playback.ts'

const api: DesktopAPI = Object.freeze({
  getState: () => ipcRenderer.invoke(CHANNELS.state),
  setPreferences: (patch: Partial<Preferences>) => ipcRenderer.invoke(CHANNELS.preferences, patch),
  getCollection: (id: string) => ipcRenderer.invoke(CHANNELS.collection, id),
  getNotices: () => ipcRenderer.invoke(CHANNELS.notices),
  importShare: (link: string, name: string) => ipcRenderer.invoke(CHANNELS.importShare, link, name),
  searchOnline: (queryOrRequest: string | OnlineSearchRequest, force = false) => ipcRenderer.invoke(CHANNELS.onlineSearch, queryOrRequest, force),
  matchTrack: (reference: TrackReference, force = false) => ipcRenderer.invoke(CHANNELS.matchTrack, reference, force),
  checkResource: (candidate: CandidateId, force = false) => ipcRenderer.invoke(CHANNELS.checkResource, candidate, force),
  startLogin: () => ipcRenderer.invoke(CHANNELS.login),
  cancelLogin: () => ipcRenderer.invoke(CHANNELS.cancelLogin),
  logout: () => ipcRenderer.invoke(CHANNELS.logout),
  syncAccount: () => ipcRenderer.invoke(CHANNELS.sync),
  cancelSync: () => ipcRenderer.invoke(CHANNELS.cancelSync),
  connectNetease: (uid: string) => ipcRenderer.invoke(CHANNELS.neteaseConnect, uid),
  refreshNetease: () => ipcRenderer.invoke(CHANNELS.neteaseRefresh),
  cancelNeteaseSync: () => ipcRenderer.invoke(CHANNELS.neteaseCancel),
  logoutNetease: () => ipcRenderer.invoke(CHANNELS.neteaseLogout),
  switchAccount: (provider: 'kugou' | 'netease') => ipcRenderer.invoke(CHANNELS.switchAccount, provider),
  getSearchHistory: () => ipcRenderer.invoke(CHANNELS.searchHistory),
  addSearchHistory: (query: string) => ipcRenderer.invoke(CHANNELS.addSearchHistory, query),
  removeSearchHistory: (query: string) => ipcRenderer.invoke(CHANNELS.removeSearchHistory, query),
  clearSearchHistory: () => ipcRenderer.invoke(CHANNELS.clearSearchHistory),
  setPinned: (id: string, pinned: boolean) => ipcRenderer.invoke(CHANNELS.pin, id, pinned),
  getPlayer: () => ipcRenderer.invoke(CHANNELS.player),
  playerCommand: (command: PlayerCommand) => ipcRenderer.invoke(CHANNELS.playerCommand, command),
  reportMediaEvent: (event: MediaEvent) => ipcRenderer.invoke(CHANNELS.mediaEvent, event),
  getPlaybackLibrary: () => ipcRenderer.invoke(CHANNELS.playbackLibrary),
  importLocal: (reference?: TrackReference) => ipcRenderer.invoke(CHANNELS.importLocal, reference),
  removeLocal: (id: string) => ipcRenderer.invoke(CHANNELS.removeLocal, id),
  clearHistory: () => ipcRenderer.invoke(CHANNELS.clearHistory),
  playHistory: (id: string) => ipcRenderer.invoke(CHANNELS.playHistory, id),
  enqueueHistory: (id: string) => ipcRenderer.invoke(CHANNELS.enqueueHistory, id),
  chooseCacheDirectory: () => ipcRenderer.invoke(CHANNELS.chooseCache),
  resetCacheDirectory: () => ipcRenderer.invoke(CHANNELS.resetCache),
  clearAudioCache: () => ipcRenderer.invoke(CHANNELS.clearCache),
  checkUpdate: () => ipcRenderer.invoke(CHANNELS.checkUpdate),
  applyUpdate: () => ipcRenderer.invoke(CHANNELS.applyUpdate),
  onPlayerChanged: (callback: (state: PlayerState) => void) => {
    const listener = (_event: unknown, state: PlayerState): void => callback(state)
    ipcRenderer.on(CHANNELS.playerChanged, listener)
    return () => ipcRenderer.removeListener(CHANNELS.playerChanged, listener)
  },
  onStateChanged: (callback: (state: AppState) => void) => {
    const listener = (_event: unknown, state: AppState): void => callback(state)
    ipcRenderer.on(CHANNELS.changed, listener)
    return () => ipcRenderer.removeListener(CHANNELS.changed, listener)
  }
})

contextBridge.exposeInMainWorld('suMusic', api)
