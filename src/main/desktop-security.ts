import type { BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

// The import suite owns the common bridge/protocol checks for all desktop tests.
export async function verifyDesktopSecurity(window: BrowserWindow, root: string): Promise<void> {
  const evaluate = <T>(code: string): Promise<T> => window.webContents.executeJavaScript(code, true) as Promise<T>
  const bridge = await evaluate<{ node: boolean; methods: string[]; frozen: boolean }>('({node:typeof window.require!=="undefined"||typeof window.process!=="undefined",methods:Object.keys(window.suMusic),frozen:Object.isFrozen(window.suMusic)})')
  assert.equal(bridge.node, false); assert.equal(bridge.frozen, true)
  assert.deepEqual(bridge.methods.sort(), ['getCollection','getNotices','getState','onStateChanged','setPreferences','importShare','searchOnline','searchLibrary','matchTrack','checkResource','startLogin','cancelLogin','logout','syncAccount','cancelSync','setPinned','getPlayer','playerCommand','reportMediaEvent','getPlaybackLibrary','importLocal','removeLocal','clearHistory','playHistory','chooseCacheDirectory','resetCacheDirectory','clearAudioCache','checkUpdate','applyUpdate','onPlayerChanged'].sort())
  for (const command of [
    'window.suMusic.setPreferences({filename:"C:/outside-workspace",token:"synthetic"})',
    'window.suMusic.matchTrack({collectionId:"one",position:1,token:"extra"})',
    'window.suMusic.checkResource({providerId:"gd",sourceId:"kugou",trackId:"100"})',
    'window.suMusic.playerCommand({type:"play",target:{kind:"file",filename:"C:/private"}})'
  ]) assert.equal((await evaluate<{ok: boolean}>(command)).ok, false)
  const marker = path.join(root, 'outside-renderer-marker.txt')
  fs.writeFileSync(marker, 'synthetic-private-file')
  assert.equal(await evaluate<boolean>('fetch('+JSON.stringify(pathToFileURL(marker).href)+').then(()=>false).catch(()=>true)'), true)
  assert.equal(await evaluate<boolean>('fetch("su-music://app/..%2f..%2foutside-renderer-marker.txt").then(response=>!response.ok).catch(()=>true)'), true)
}
