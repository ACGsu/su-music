import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { CHANNELS } from '../shared/contracts.ts'
import type { AppState, Preferences } from '../shared/contracts.ts'
import type { MusicDatabase } from './database.ts'
import type { CredentialVault } from './vault.ts'

const TOKEN = 'p0-isolated-virtual-credential-only'
export function seedSmokeData(db: MusicDatabase): void {
  if (db.getCollections().length) return
  db.insertCollection({ id: 'fixture-default', name: '我喜欢（布局验证样本）', kind: 'default', provider: 'kugou', accountKey: 'local', sourceKey: '0:fixture-default', order: 0 })
  db.insertCollection({ id: 'fixture-album', name: '長いアルバム名と日本語の表示を確認するための原声带 · 布局样本', kind: 'favorite', subtype: 'album', provider: 'kugou', accountKey: 'local', sourceKey: '1:fixture-album', order: 1 })
  db.insertCollection({ id: 'fixture-created', name: '窗边的安静 · 布局样本', kind: 'created', provider: 'kugou', accountKey: 'local', sourceKey: '0:fixture-created', order: 2 })
  const track = { title: 'Original ver. / 長い日本語の曲名と中文名称用于验证完整显示', filename: '原始文件名', artist: '布局样本歌手', album: '布局测试原声带', durationMs: 42000, version: 'Original ver.', hash: 'same-synthetic-recording' }
  db.insertTrack('fixture-default', { ...track, position: 1 }); db.insertTrack('fixture-default', { ...track, position: 2 })
  db.insertTrack('fixture-album', { ...track, position: 1 })
}
export async function runSmoke(window: BrowserWindow, db: MusicDatabase, vault: CredentialVault, options: { phase: string; state: () => AppState; packaged: boolean }): Promise<void> {
  const root = path.dirname(app.getPath('userData'))
  const report: Record<string, unknown> = { at: new Date().toISOString(), phase: options.phase, packaged: options.packaged, environment: options.state().environment }
  const evaluate = <T>(script: string): Promise<T> => window.webContents.executeJavaScript(script, true) as Promise<T>
  const waitFor = async (script: string): Promise<void> => {
    const limit = Date.now() + 20000
    while (Date.now() < limit) { if (await evaluate<boolean>(script)) return; await delay(80) }
    throw new Error('SMOKE_RENDERER_WAIT_TIMEOUT')
  }
  const preferences = async (): Promise<Preferences> => evaluate("window.suMusic.getState().then(result=>{if(!result.ok)throw Error(result.error.code);return result.value.preferences})")
  const click = async (selector: string): Promise<void> => { await evaluate('document.querySelector(' + JSON.stringify(selector) + ').click()'); await delay(180) }
  const set = async (patch: Partial<Preferences>): Promise<void> => {
    const result = await evaluate<{ ok: boolean }>('window.suMusic.setPreferences(' + JSON.stringify(patch) + ')')
    assert.equal(result.ok, true); await delay(150)
  }
  const capture = async (name: string): Promise<void> => {
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    await delay(200); const image = await window.webContents.capturePage()
    if (image.isEmpty()) throw new Error('EMPTY_SCREENSHOT')
    fs.writeFileSync(path.join(root, name + '.png'), image.toPNG())
  }
  try {
    await waitFor('document.body.dataset.ready === "true"')
    const bridge = await evaluate<{ node: boolean; methods: string[]; frozen: boolean }>('({node:typeof window.require!=="undefined"||typeof window.process!=="undefined",methods:Object.keys(window.suMusic),frozen:Object.isFrozen(window.suMusic)})')
    assert.equal(bridge.node, false); assert.equal(bridge.frozen, true)
    assert.deepEqual(bridge.methods.sort(), ['getCollection', 'getNotices', 'getState', 'onStateChanged', 'setPreferences', 'importShare', 'searchOnline', 'searchLibrary', 'matchTrack', 'checkResource','startLogin','cancelLogin','logout','syncAccount','cancelSync','setPinned','getPlayer','playerCommand','reportMediaEvent','getPlaybackLibrary','importLocal','removeLocal','clearHistory','playHistory','chooseCacheDirectory','resetCacheDirectory','clearAudioCache','onPlayerChanged'].sort())
    report.rendererNodeUnavailable = true; report.fixedBridgeSurfaceVerified = true
    const invalid = await evaluate<{ ok: boolean }>('window.suMusic.setPreferences({filename:"C:/outside-workspace",token:"synthetic"})')
    assert.equal(invalid.ok, false); report.invalidIpcPayloadRejected = true
    const outside = path.join(root, 'outside-renderer-marker.txt'); fs.writeFileSync(outside, 'synthetic-private-file')
    const fileBlocked = await evaluate<boolean>('fetch(' + JSON.stringify(pathToFileURL(outside).href) + ').then(()=>false).catch(()=>true)')
    assert.equal(fileBlocked, true); report.rendererArbitraryFileFetchBlocked = true
    assert.equal(await evaluate<boolean>('fetch("su-music://app/..%2f..%2foutside-renderer-marker.txt").then(response=>!response.ok).catch(()=>true)'), true)
    report.assetTraversalBlocked = true
    assert.equal(options.state().security.credentialProtectionAvailable, true)
    if (options.phase === 'first') {
      await vault.save({ provider: 'synthetic', token: TOKEN })
      assert.equal((await vault.read<{ token: string }>())!.token, TOKEN)
      assert.equal(fs.readFileSync(vault.filename).includes(TOKEN), false)
      report.realWindowsEncryptionRoundTrip = true
    } else {
      const restored = await preferences()
      assert.equal(restored.theme, 'night'); assert.equal(restored.density, 'compact'); assert.equal(restored.libraryView, 'list'); assert.equal(restored.volume, 87)
      assert.equal((await vault.read<{ token: string }>())!.token, TOKEN)
      report.preferencesRestoredInNewProcess = true; report.encryptedCredentialRestoredInNewProcess = true
      await vault.clear(); report.virtualCredentialCleaned = true
    }
    window.setSize(1280, 820)
    await set({ currentPage: 'library', theme: 'day', libraryView: 'grid', librarySort: 'recent' })
    await waitFor('document.documentElement.dataset.theme==="day" && document.querySelectorAll("[data-collections] .collection-card").length===3')
    await capture('day-library')
    await click('[data-nav="settings"]')
    await click('[data-theme-choice="night"]')
    await waitFor('document.documentElement.dataset.theme==="night"')
    await click('[data-density="compact"]')
    await capture('night-settings')
    await click('[data-notices]')
    await waitFor('document.querySelector("dialog").open')
    assert((await evaluate<string>('document.querySelector("dialog pre").textContent')).includes('electron'))
    await evaluate('document.querySelector("dialog").close()')
    report.bundledNoticesDisplayed = true
    await click('[data-nav="library"]'); await click('[data-view="list"]')
    await click('[data-collections] .collection-card')
    await waitFor('document.querySelectorAll(".track-table tbody tr").length === 2')
    await capture('night-detail')
    await click('[data-queue]'); await waitFor('Boolean(document.querySelector(".queue-panel"))')
    await evaluate('window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape"}))')
    await waitFor('!document.querySelector(".queue-panel")')
    await evaluate('const input=document.querySelector("[data-volume]");input.value="87";input.dispatchEvent(new Event("input",{bubbles:true}));input.dispatchEvent(new Event("change",{bubbles:true}));')
    await waitFor('document.querySelector("[data-volume]").value === "87"')
    await set({ theme: 'night', density: 'compact', libraryView: 'list', volume: 87, currentPage: 'settings' })
    window.setSize(960, 640); await capture('minimum-window')
    const layout = await evaluate<{ overflow: boolean; headingColor: string; accent: string }>('({overflow:document.documentElement.scrollWidth>innerWidth||document.querySelector(".content").scrollWidth>document.querySelector(".content").clientWidth,headingColor:getComputedStyle(document.querySelector("h1")).color,accent:getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()})')
    assert.equal(layout.overflow, false); assert.equal(layout.accent.toUpperCase(), '#FFFA00')
    report.minimumWindowNoOuterOverflow = true; report.themeNavigationDensityQueueAndVolumeVerified = true
    assert.equal(db.getCollections().reduce((sum, row) => sum + row.positionCount, 0), 3)
    assert.equal(JSON.stringify(options.state()).includes(TOKEN), false)
    report.repeatedPositionsPreserved = true; report.credentialAbsentFromRendererState = true; report.schemaVersion = db.schemaVersion(); report.passed = true
  } catch (error) { report.passed = false; report.error = error instanceof Error ? error.message : 'SMOKE_FAILED'; throw error }
  finally { fs.writeFileSync(path.join(root, 'report-' + options.phase + '.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)) }
}
