import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, net, protocol, safeStorage, session } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { MusicDatabase } from './database.ts'
import { CredentialVault } from './vault.ts'
import { LocalLog } from './logging.ts'
import { APP_URL, DEVELOPMENT_URL, PRODUCTION_CSP, assetPath, isTrustedPage, safeCode } from './security.ts'
import { CHANNELS } from '../shared/contracts.ts'
import type { AppState, Result } from '../shared/contracts.ts'
import { runSmoke, seedSmokeData } from './smoke.ts'
import { GdRequestBudget } from './music/budget.ts'
import { GdNeteaseAdapter } from './music/gd.ts'
import { MusicSourceService } from './music/service.ts'
import { sourceMessage } from './music/errors.ts'
import { validateCandidateId, validateQuery, validateTrackReference } from '../shared/music.ts'
import { PublicHttpClient } from './music/http.ts'
import { KugouShareImporter } from './music/share.ts'
import { p1MockHttp, runP1Smoke } from './p1-smoke.ts'
import { CollectionCoverCache } from './music/covers.ts'
import { AccountController, accountMessage } from './account/controller.ts'
import { KugouHttpTransport } from './account/protocol.ts'
import {P2SmokeTransport,runP2Smoke} from './p2-smoke.ts'
import {recordP2State} from './p2-observer.ts'
import {SongCache} from './player/cache.ts'
import {MediaRegistry} from './player/media.ts'
import {PlaybackSources} from './player/source.ts'
import {PlayerController} from './player/controller.ts'
import {PlayerError,playerMessage} from './player/errors.ts'
import {registerLocalFile} from './player/local.ts'
import {validateMediaEvent,validatePlayerCommand} from '../shared/playback.ts'
import type {PlaybackLibrary} from '../shared/playback.ts'
import {p3MockAudio,p3MockHttp,runP3Smoke,seedP3Smoke} from './p3-smoke.ts'
import {realAudioFetch,runRealAudio,seedRealControl} from './p3-real-audio.ts'
import {p4MockFetch,p4MockHttp,P4Transport,runP4Smoke,seedP4Smoke} from './p4-smoke.ts'

protocol.registerSchemesAsPrivileged([{ scheme: 'su-music', privileges: { standard: true, secure: true, supportFetchAPI: true, stream:true } }])
app.setName('Su Music')
const p1Smoke = process.argv.includes('--p1-smoke')
const p3Smoke=process.argv.includes('--p3-smoke')
const p4Smoke=process.argv.includes('--p4-smoke')
const p4Scale=Number(process.argv.find(value=>value.startsWith('--force-device-scale-factor='))?.split('=')[1]??1)
if(p4Smoke&&![1,1.25,1.5].includes(p4Scale))throw new Error('P4_SCALE_INVALID')
const p3RealAudio=process.argv.includes('--p3-real-audio'),normalUserData=app.getPath('userData')
const p2Smoke=process.argv.includes('--p2-smoke'),p2Live=process.argv.includes('--p2-live')
const smoke = p4Smoke || p3RealAudio || p3Smoke || p2Smoke || p1Smoke || process.argv.includes('--p0-smoke') || Boolean(process.env.SU_MUSIC_SMOKE_ROOT)
let p2Root:string|null=null
const phase = process.argv.find(value => value.startsWith('--smoke-phase='))?.slice(14) ?? process.env.SU_MUSIC_SMOKE_PHASE ?? 'first'
if (smoke) {
  const argument = process.argv.find(value => value.startsWith('--smoke-root='))?.slice(13) ?? process.env.SU_MUSIC_SMOKE_ROOT
  if (!argument) throw new Error('SMOKE_ROOT_REQUIRED')
  const root = path.resolve(argument), allowed = path.resolve(process.cwd(), p4Smoke?'.p4':p3Smoke||p3RealAudio?'.p3':p2Smoke?'.p2':p1Smoke ? '.p1' : '.p0')
  if (!root.startsWith(allowed + path.sep)) throw new Error('SMOKE_ROOT_OUTSIDE_WORKSPACE')
  if (!fs.realpathSync(root).startsWith(fs.realpathSync(allowed) + path.sep)) throw new Error('SMOKE_ROOT_OUTSIDE_WORKSPACE')
  const data = path.join(root, 'user-data'); fs.mkdirSync(data, { recursive: true }); app.setPath('userData', data); app.setPath('sessionData', data)
}
if(p2Live){
  const value=process.argv.find(value=>value.startsWith('--p2-root='))?.slice(10);if(!value)throw new Error('P2_PROFILE_REQUIRED')
  const root=path.resolve(value),allowed=path.resolve(process.cwd(),'.p2');fs.mkdirSync(root,{recursive:true})
  if(!root.startsWith(allowed+path.sep)||!fs.realpathSync(root).startsWith(fs.realpathSync(allowed)+path.sep))throw new Error('P2_PROFILE_OUTSIDE_WORKSPACE')
  p2Root=root;fs.mkdirSync(path.join(root,'user-data'),{recursive:true});app.setPath('userData',path.join(root,'user-data'));app.setPath('sessionData',path.join(root,'user-data'))
}
let window: BrowserWindow | null = null
let database: MusicDatabase | null = null
let vault: CredentialVault | null = null
let log: LocalLog | null = null
let budget: GdRequestBudget | null = null
let music: MusicSourceService | null = null
let covers: CollectionCoverCache | null = null
let account: AccountController | null = null
let audioCache:SongCache|null=null,mediaRegistry:MediaRegistry|null=null,playbackSources:PlaybackSources|null=null,player:PlayerController|null=null
let coverRefresh:Promise<void>|null=null,lastCoverSync:string|null=null
let expectedURL = APP_URL
const singleInstance=smoke||p2Live||app.requestSingleInstanceLock()
if(!singleInstance)app.quit()
app.on('second-instance',()=>{if(window&&!window.isDestroyed()){if(window.isMinimized())window.restore();window.focus()}})
function currentState(): AppState {
  if (!database || !vault) throw new Error('APPLICATION_NOT_READY')
  const preferences = database.getPreferences(), collections = database.getCollections().map(item=>({...item,coverUrl:covers?.url(item.id)??null}))
  return {
    app: { name: 'Su Music', version: app.getVersion(), packaged: app.isPackaged, testProfile: smoke },
    preferences, effectiveTheme: preferences.theme === 'system' ? nativeTheme.shouldUseDarkColors ? 'night' : 'day' : preferences.theme,
    library: { collections, positionCount: collections.filter(row => row.kind !== 'shared').reduce((sum, row) => sum + row.positionCount, 0) },
    security: { credentialProtectionAvailable: vault.available() },
    environment: { electron: process.versions.electron, node: process.versions.node, sqlite: database.sqliteVersion(), platform: process.platform }
    ,account:account?.snapshot()
  }
}
function updateTheme(): void {
  if (!window || window.isDestroyed()) return
  player?.accountChanged()
  syncNativeTheme()
  const state = currentState(), day = state.effectiveTheme === 'day'
  window.setBackgroundColor(day ? '#F2F0ED' : '#0B0C0E')
  if (process.platform === 'win32') window.setTitleBarOverlay({ color: day ? '#EAEAE6' : '#121316', symbolColor: day ? '#1A1A18' : '#F0F2F5', height: 42 })
  window.webContents.send(CHANNELS.changed, state)
  if(p2Root&&database)try{recordP2State(p2Root,state,database)}catch{}
  if(!smoke&&state.account?.sync.phase==='completed'&&state.account.sync.lastSuccessAt!==lastCoverSync){lastCoverSync=state.account.sync.lastSuccessAt;refreshCoverCache()}
}
function refreshCoverCache():void{
  if(coverRefresh||!database||!covers)return
  coverRefresh=(async()=>{for(const collection of database!.getCollections()){if(!database||!covers)return;await covers.refresh(collection.id);updateTheme()}})().catch(()=>{}).finally(()=>{coverRefresh=null})
}
function syncNativeTheme(): void {
  const preference = database!.getPreferences().theme
  const source = preference === 'system' ? 'system' : preference === 'day' ? 'light' : 'dark'
  if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source
}
function playbackLibrary():PlaybackLibrary{return{local:database!.getLocalTracks(),history:database!.getHistory(),issues:database!.getIssues(),cache:audioCache!.snapshot()}}
function localId(value:unknown):string{if(typeof value!=='string'||!/^[-\w]{1,128}$/.test(value))throw new Error('INVALID_REQUEST');return value}
function registerIPC(target: BrowserWindow): void {
  const protect = (handler: (...args: unknown[]) => unknown) => async (event: Electron.IpcMainInvokeEvent, ...args: unknown[]): Promise<Result<unknown>> => {
    const frame = event.senderFrame, main = target.webContents.mainFrame
    if (event.sender !== target.webContents || !frame || frame.processId !== main.processId || frame.routingId !== main.routingId || !isTrustedPage(frame.url, expectedURL)) {
      log?.event('ipc_rejected', { code: 'IPC_SENDER_DENIED' })
      return { ok: false, error: { code: 'IPC_SENDER_DENIED', message: '此请求无法执行。' } }
    }
    try { return { ok: true, value: await handler(...args) } }
    catch (error) { log?.event('error', { code: safeCode(error) }); return { ok: false, error: { code: safeCode(error), message: error instanceof PlayerError?playerMessage(error):accountMessage(error)??sourceMessage(error) } } }
  }
  const force = (args: unknown[]): boolean => {
    if (args.length < 1 || args.length > 2 || args[1] !== undefined && typeof args[1] !== 'boolean') throw new Error('INVALID_REQUEST')
    return args[1] === true
  }
  const handlers = {
    [CHANNELS.state]: (...args: unknown[]) => { if (args.length) throw new Error('INVALID_REQUEST'); return currentState() },
    [CHANNELS.preferences]: (...args: unknown[]) => { if (args.length !== 1) throw new Error('INVALID_REQUEST'); database!.setPreferences(args[0]); updateTheme(); log?.event('preferences_saved', { theme: database!.getPreferences().theme }); return currentState() },
    [CHANNELS.collection]: (...args: unknown[]) => { if (args.length !== 1 || typeof args[0] !== 'string' || args[0].length > 128) throw new Error('INVALID_REQUEST'); const result=database!.getCollection(args[0]);if(result){database!.markOpened(result.collection.id);updateTheme()}return result?{...result,collection:{...result.collection,coverUrl:covers?.url(result.collection.id)??null}}:null },
    [CHANNELS.notices]: (...args: unknown[]) => { if (args.length) throw new Error('INVALID_REQUEST'); return fs.readFileSync(path.join(app.getAppPath(), 'licenses', 'THIRD_PARTY_NOTICES.md'), 'utf8') },
    [CHANNELS.importShare]: async (...args: unknown[]) => {
      if (args.length !== 2 || typeof args[0] !== 'string' || typeof args[1] !== 'string') throw new Error('INVALID_REQUEST')
      const imported = await music!.importShare(args[0], args[1]);
      if(imported)await covers!.refresh(imported.collection.id)
      updateTheme();return imported?{...imported,collection:{...imported.collection,coverUrl:covers?.url(imported.collection.id)??null}}:imported
    },
    [CHANNELS.onlineSearch]: (...args: unknown[]) => { const refresh = force(args); return music!.search(validateQuery(args[0]), refresh) },
    [CHANNELS.librarySearch]: (...args: unknown[]) => { if (args.length !== 1) throw new Error('INVALID_REQUEST'); return music!.searchLibrary(validateQuery(args[0])) },
    [CHANNELS.matchTrack]: (...args: unknown[]) => { const refresh = force(args); return music!.match(validateTrackReference(args[0]), refresh) },
    [CHANNELS.checkResource]: (...args: unknown[]) => { const refresh = force(args); return music!.checkResource(validateCandidateId(args[0]), refresh) },
    [CHANNELS.login]:async(...args:unknown[])=>{if(args.length)throw new Error('INVALID_REQUEST');await account!.startLogin();return currentState()},
    [CHANNELS.cancelLogin]:(...args:unknown[])=>{if(args.length)throw new Error('INVALID_REQUEST');account!.cancelLogin();return currentState()},
    [CHANNELS.logout]:async(...args:unknown[])=>{if(args.length)throw new Error('INVALID_REQUEST');await account!.logout();return currentState()},
    [CHANNELS.sync]:(...args:unknown[])=>{if(args.length)throw new Error('INVALID_REQUEST');void account!.sync().catch(()=>{});return currentState()},
    [CHANNELS.cancelSync]:(...args:unknown[])=>{if(args.length)throw new Error('INVALID_REQUEST');account!.cancelSync();return currentState()},
    [CHANNELS.pin]:(...args:unknown[])=>{if(args.length!==2||typeof args[0]!=='string'||args[0].length>128||typeof args[1]!=='boolean')throw new Error('INVALID_REQUEST');database!.setPinned(args[0],args[1]);updateTheme();return currentState()},
    [CHANNELS.player]:(...args:unknown[])=>{if(args.length)throw new Error('INVALID_REQUEST');return player!.snapshot()},
    [CHANNELS.playerCommand]:(...args:unknown[])=>{if(args.length!==1)throw new Error('INVALID_REQUEST');return player!.command(validatePlayerCommand(args[0]))},
    [CHANNELS.mediaEvent]:(...args:unknown[])=>{if(args.length!==1)throw new Error('INVALID_REQUEST');player!.event(validateMediaEvent(args[0]));return null},
    [CHANNELS.playbackLibrary]:(...args:unknown[])=>{if(args.length)throw new Error('INVALID_REQUEST');return playbackLibrary()},
    [CHANNELS.importLocal]:async(...args:unknown[])=>{
      if(args.length>1)throw new Error('INVALID_REQUEST')
      const reference=args[0]===undefined?undefined:validateTrackReference(args[0]),signature=reference?database!.originalSignature(reference):null
      if(reference&&!signature)throw new PlayerError('TRACK_NOT_FOUND')
      const result=await dialog.showOpenDialog(target,{title:reference?'关联本地音频':'添加本地音乐',properties:reference?['openFile']:['openFile','multiSelections'],filters:[{name:'音频文件',extensions:['mp3','flac','wav']}]})
      if(result.canceled)return[]
      const files=result.filePaths.slice(0,100).map(filename=>registerLocalFile(database!,filename))
      if(reference&&files[0]){if(signature!==database!.originalSignature(reference))throw new PlayerError('TRACK_CHANGED');playbackSources!.linkLocal(reference,files[0].id)}
      player!.libraryChanged();return files
    },
    [CHANNELS.removeLocal]:(...args:unknown[])=>{if(args.length!==1)throw new Error('INVALID_REQUEST');database!.removeLocal(localId(args[0]));player!.libraryChanged();return playbackLibrary()},
    [CHANNELS.clearHistory]:(...args:unknown[])=>{if(args.length)throw new Error('INVALID_REQUEST');player!.clearHistory();return playbackLibrary()},
    [CHANNELS.playHistory]:(...args:unknown[])=>{if(args.length!==1)throw new Error('INVALID_REQUEST');return player!.playHistory(localId(args[0]))},
    [CHANNELS.chooseCache]:async(...args:unknown[])=>{
      if(args.length)throw new Error('INVALID_REQUEST')
      const result=await dialog.showOpenDialog(target,{title:'选择歌曲缓存位置',properties:['openDirectory','createDirectory'],defaultPath:audioCache!.snapshot().directory})
      if(result.canceled||!result.filePaths[0])return audioCache!.snapshot()
      try{return audioCache!.choose(result.filePaths[0])}catch{throw new PlayerError('CACHE_DIRECTORY_UNWRITABLE')}
    },
    [CHANNELS.resetCache]:(...args:unknown[])=>{if(args.length)throw new Error('INVALID_REQUEST');try{return audioCache!.reset()}catch{throw new PlayerError('CACHE_DIRECTORY_UNWRITABLE')}},
    [CHANNELS.clearCache]:(...args:unknown[])=>{if(args.length)throw new Error('INVALID_REQUEST');return audioCache!.clear(mediaRegistry!.protectedFiles())}
  }
  for (const [channel, handler] of Object.entries(handlers)) { ipcMain.removeHandler(channel); ipcMain.handle(channel, protect(handler)) }
}
async function createWindow(): Promise<void> {
  syncNativeTheme()
  const state = currentState(), day = state.effectiveTheme === 'day'
  const saved = database!.getSetting<{ width: number; height: number }>('window-bounds', { width: 1280, height: 820 })
  const width = Number.isFinite(saved.width) ? Math.max(960, Math.min(2560, saved.width)) : 1280
  const height = Number.isFinite(saved.height) ? Math.max(640, Math.min(1600, saved.height)) : 820
  const target = new BrowserWindow({
    width, height, minWidth: 960, minHeight: 640, show: false, title: p2Live?'Su Music · P2 账号验证':'Su Music', autoHideMenuBar: true,
    backgroundColor: day ? '#F2F0ED' : '#0B0C0E', titleBarStyle: 'hidden',
    titleBarOverlay: { color: day ? '#EAEAE6' : '#121316', symbolColor: day ? '#1A1A18' : '#F0F2F5', height: 42 },
    icon: path.join(app.getAppPath(), 'build', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, '../preload/index.cjs'), sandbox: true, nodeIntegration: false, contextIsolation: true,
      webSecurity: true, allowRunningInsecureContent: false, spellcheck: false, backgroundThrottling: false,autoplayPolicy:'no-user-gesture-required' }
  })
  window = target
  const development = !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL)
  expectedURL = development ? DEVELOPMENT_URL : APP_URL
  if (development && !isTrustedPage(process.env.ELECTRON_RENDERER_URL!, DEVELOPMENT_URL)) throw new Error('DEVELOPMENT_ORIGIN_DENIED')
  registerIPC(target)
  target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  target.webContents.on('will-navigate', (event, url) => { if (!isTrustedPage(url, expectedURL)) event.preventDefault() })
  target.on('close', () => { const bounds = target.getBounds(); database?.setSetting('window-bounds', { width: bounds.width, height: bounds.height }) })
  target.on('closed', () => { window = null })
  if (development) await target.loadURL(expectedURL)
  else await target.loadURL(APP_URL)
  if (smoke) {
    target.showInactive()
    try { if(p4Smoke)await runP4Smoke(target,database!,player!,phase,p4Scale);else if(p3RealAudio)await runRealAudio(target,database!,player!,audioCache!,mediaRegistry!);else if(p3Smoke)await runP3Smoke(target,database!,player!,audioCache!,mediaRegistry!,phase);else if(p2Smoke)await runP2Smoke(target,database!,account!,vault!,phase);else if (p1Smoke) await runP1Smoke(target,database!,phase); else await runSmoke(target, database!, vault!, { phase, state: currentState, packaged: app.isPackaged }); target.close() }
    catch (error) { console.error(JSON.stringify({ smokePassed: false, code: safeCode(error) })); app.exit(1) }
  } else target.show()
}
app.whenReady().then(async () => {
  if(!singleInstance)return
  log = new LocalLog(path.join(app.getPath('userData'), 'logs'))
  database = new MusicDatabase(path.join(app.getPath('userData'), 'library.sqlite'))
  budget = new GdRequestBudget(path.join(p3RealAudio?normalUserData:app.getPath('userData'), 'gd-budget.sqlite'))
  const smokeRoot=path.dirname(app.getPath('userData'))
  const liveFetch=p4Smoke?p4MockFetch(smokeRoot):p3RealAudio?realAudioFetch():fetch
  const http = p4Smoke?p4MockHttp(smokeRoot):p3Smoke?p3MockHttp(smokeRoot):p1Smoke ? p1MockHttp(smokeRoot) : new PublicHttpClient(liveFetch)
  const adapter=new GdNeteaseAdapter(database,budget,http)
  music = new MusicSourceService(database, adapter, new KugouShareImporter(http))
  audioCache=new SongCache(database,app.getPath('userData'))
  mediaRegistry=new MediaRegistry(p3Smoke?p3MockAudio(path.dirname(app.getPath('userData'))):liveFetch,audioCache)
  playbackSources=new PlaybackSources(database,music,adapter,audioCache)
  player=new PlayerController(database,playbackSources,mediaRegistry,value=>{if(window&&!window.isDestroyed())window.webContents.send(CHANNELS.playerChanged,value)})
  database.onCatalogChanged(changes=>player?.catalogChanged(changes))
  if(p3Smoke)seedP3Smoke(database,phase)
  if(p4Smoke)seedP4Smoke(database,smokeRoot,phase)
  if(p3RealAudio)seedRealControl(database)
  covers = new CollectionCoverCache(database,path.join(app.getPath('userData'),'covers'),input=>{
    const image=nativeImage.createFromBuffer(input),size=image.getSize()
    if(image.isEmpty()||size.width<=0||size.height<=0||size.width>4096||size.height>4096)throw new Error('COVER_INVALID')
    const scale = Math.min(1, 500 / size.width, 500 / size.height)
    return image.resize({width:Math.max(1,Math.round(size.width*scale)),height:Math.max(1,Math.round(size.height*scale)),quality:'good'}).toJPEG(85)
  },http)
  if (smoke && !p1Smoke && !p2Smoke && !p4Smoke && phase === 'first') seedSmokeData(database)
  const protectionAvailable = await safeStorage.isAsyncEncryptionAvailable()
  vault = new CredentialVault(path.join(app.getPath('userData'), 'private'), {
    available: () => protectionAvailable,
    encrypt: value => safeStorage.encryptStringAsync(value),
    decrypt: async value => { const decoded = await safeStorage.decryptStringAsync(value); return { value: decoded.result, reencrypt: decoded.shouldReEncrypt } }
  })
  account=new AccountController(database,vault,p4Smoke?new P4Transport(smokeRoot):p2Smoke?new P2SmokeTransport(smokeRoot):new KugouHttpTransport(),updateTheme,p2Smoke?{firstPollMs:30,pollMs:100}:undefined)
  if(p2Live)database.setPreferences({currentPage:'settings'})
  log.event('startup', { schemaVersion: database.schemaVersion(), protectionAvailable })
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  const rendererRoot = path.resolve(__dirname, '../renderer')
  protocol.handle('su-music', async request => {
    if(request.url.startsWith('su-music://media/'))return mediaRegistry!.respond(request)
    if (request.method !== 'GET') return new Response('Forbidden', { status: 403 })
    const imageRequest=/^su-music:\/\/app\/cover\/([a-f0-9]{64})\.jpg$/.exec(request.url)
    if(imageRequest){const bytes=covers?.read(imageRequest[1]!);return bytes?new Response(new Uint8Array(bytes),{headers:{'Content-Type':'image/jpeg','X-Content-Type-Options':'nosniff','Cache-Control':'private, max-age=86400'}}):new Response('Not found',{status:404})}
    const file = assetPath(rendererRoot, request.url)
    if (!file) return new Response('Forbidden', { status: 403 })
    try {
      const real = fs.realpathSync(file), root = fs.realpathSync(rendererRoot)
      if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) return new Response('Forbidden', { status: 403 })
      const response = await net.fetch(pathToFileURL(real).href), headers = new Headers(response.headers)
      headers.set('Content-Security-Policy', PRODUCTION_CSP); headers.set('X-Content-Type-Options', 'nosniff'); headers.set('Cache-Control', 'no-store')
      return new Response(response.body, { status: response.status, headers })
    } catch { return new Response('Not found', { status: 404 }) }
  })
  nativeTheme.on('updated', updateTheme)
  await createWindow()
  if(!smoke)void account.restore()
  if(!smoke&&!p2Live)refreshCoverCache()
  app.on('activate', () => { if (!window) void createWindow() })
}).catch(error => {
  const code = safeCode(error)
  log?.event('error', { code })
  if (smoke) console.error(JSON.stringify({ smokePassed: false, code }))
  else dialog.showErrorBox('Su Music 暂时无法启动', '本地资料未能读取。请重新启动应用，或查看验证报告。\n错误编号：' + code)
  app.exit(1)
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('will-quit', () => { player?.close();player=null;mediaRegistry?.close();mediaRegistry=null;audioCache?.close();audioCache=null;account?.close();account=null;log?.event('shutdown'); budget?.close(); budget = null; database?.close(); database = null; music = null })
