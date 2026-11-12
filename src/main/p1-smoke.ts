import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { MusicDatabase } from './database.ts'
import type { ImportedPlaylist, MatchResult, ResourceCheck, SourceCandidate } from '../shared/music.ts'
import { candidateKey } from '../shared/music.ts'
import { PublicHttpClient } from './music/http.ts'

interface P1Observations { matches: (MatchResult & { reference: { collectionId: string; position: number } })[]; observedResources: ResourceCheck[]; control: { candidate: SourceCandidate; resource: ResourceCheck } }
function fixtures(root: string): { playlist: ImportedPlaylist; observations: P1Observations } {
  return { playlist: JSON.parse(fs.readFileSync(path.join(root,'fixture.json'),'utf8')) as ImportedPlaylist,
    observations: JSON.parse(fs.readFileSync(path.join(root,'observations.json'),'utf8')) as P1Observations }
}
export function p1MockHttp(root: string): PublicHttpClient {
  const { playlist } = fixtures(root)
  return new PublicHttpClient(async input => {
    const url = new URL(String(input))
    if (url.hostname === 't1.kugou.com') return new Response(null,{status:302,headers:{location:'http://wwwapi.kugou.com/share/zlist.html?global_collection_id='+encodeURIComponent(playlist.sourceKey)}})
    if (url.hostname === 'wwwapi.kugou.com') return new Response('var dataFromSmarty = '+JSON.stringify(playlist.tracks.map(track=>track.raw))+';',{headers:{'content-type':'text/html'}})
    if (url.hostname === 'm.kugou.com') return new Response(JSON.stringify(JSON.parse(fs.readFileSync(path.join(root,'cover-metadata.json'),'utf8'))),{headers:{'content-type':'application/json'}})
    if (url.hostname === 'imge.kugou.com') return new Response(new Uint8Array(fs.readFileSync(path.join(root,'cover.png'))),{headers:{'content-type':'image/png'}})
    throw new Error('P1_SMOKE_UNEXPECTED_NETWORK_REQUEST')
  })
}
function seedObservedCache(db: MusicDatabase, root: string): void {
  const { observations } = fixtures(root)
  for (const item of observations.matches) {
    const original = db.getOriginal(item.reference)
    if (!original) throw new Error('P1_SMOKE_ORIGINAL_NOT_FOUND')
    const signature = createHash('sha256').update(JSON.stringify(original)).digest('hex')
    db.saveMatch(item.reference,signature,{...item,checkedAt:new Date().toISOString(),fromCache:true})
    for (const comparison of item.candidates) db.setSourceCache('candidate',candidateKey(comparison.candidate),comparison.candidate,86_400_000)
  }
  for (const resource of observations.observedResources) db.setSourceCache('resource_check',candidateKey(resource.candidate),resource,120_000)
  db.setSourceCache('candidate',candidateKey(observations.control.candidate),observations.control.candidate,86_400_000)
  db.setSourceCache('resource_check',candidateKey(observations.control.candidate),observations.control.resource,120_000)
  db.setSourceCache('search','carefree',{query:'Carefree',candidates:[observations.control.candidate],metadataWarning:null,fromCache:false},86_400_000)
}
export async function runP1Smoke(window: BrowserWindow, db: MusicDatabase, phase: string): Promise<void> {
  const root = path.dirname(app.getPath('userData')),{playlist}=fixtures(root)
  const report: Record<string,unknown> = { at:new Date().toISOString(),phase,packaged:app.isPackaged,
    networkMode:'fixed public metadata + synthetic cover/resource caches and share response; no external requests',
    syntheticCredentialsUsed:false,fullPlaybackClaimed:false,schemaVersion:db.schemaVersion() }
  const evaluate = <T>(script: string): Promise<T> => window.webContents.executeJavaScript(script,true) as Promise<T>
  const wait = async (script: string): Promise<void> => {
    const until=Date.now()+20_000
    while(Date.now()<until){if(await evaluate<boolean>(script))return;await delay(80)}
    throw new Error('P1_SMOKE_RENDERER_WAIT_TIMEOUT')
  }
  const click = async (selector: string): Promise<void> => { await evaluate('document.querySelector('+JSON.stringify(selector)+').click()');await delay(120) }
  const input = async (selector: string,value: string): Promise<void> => { await evaluate('(()=>{const element=document.querySelector('+JSON.stringify(selector)+');element.value='+JSON.stringify(value)+';element.dispatchEvent(new Event("input",{bubbles:true}))})()');await delay(80) }
  const set = async (value: unknown): Promise<void> => { assert.equal((await evaluate<{ok:boolean}>('window.suMusic.setPreferences('+JSON.stringify(value)+')')).ok,true);await delay(150) }
  const capture = async (name: string): Promise<void> => {
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await delay(220)
    const image=await window.webContents.capturePage();assert(!image.isEmpty());fs.writeFileSync(path.join(root,name+'.png'),image.toPNG())
  }
  try {
    await wait('document.body.dataset.ready === "true"')
    const surface=await evaluate<{node:boolean;methods:string[]}>('({node:typeof window.require!=="undefined"||typeof window.process!=="undefined",methods:Object.keys(window.suMusic)})')
    assert.equal(surface.node,false);assert.deepEqual(surface.methods.sort(),['getState','setPreferences','getCollection','getNotices','onStateChanged','importShare','searchOnline','searchLibrary','matchTrack','checkResource','startLogin','cancelLogin','logout','syncAccount','cancelSync','setPinned','getPlayer','playerCommand','reportMediaEvent','getPlaybackLibrary','importLocal','removeLocal','clearHistory','playHistory','chooseCacheDirectory','resetCacheDirectory','clearAudioCache','onPlayerChanged'].sort())
    report.restrictedBridgeVerified=true
    assert.equal((await evaluate<{ok:boolean}>('window.suMusic.matchTrack({collectionId:"one",position:1,token:"extra"})')).ok,false)
    assert.equal((await evaluate<{ok:boolean}>('window.suMusic.checkResource({providerId:"gd",sourceId:"kugou",trackId:"100"})')).ok,false)
    report.asyncInvalidRequestsRejected=true
    if (phase === 'resume') {
      assert.equal(db.getCollections().filter(item=>item.kind==='shared').length,1)
      assert.equal(db.getCollection(db.getCollections()[0]!.id)!.tracks.length,22)
      assert.equal(db.getPreferences().theme,'night')
      assert.equal(db.getPreferences().density,'compact')
      assert.equal(db.getPreferences().libraryView,'list')
      await set({currentPage:'library'})
      await wait('Boolean(document.querySelector("[data-shared-item]"))')
      const restoredList=await evaluate<{coverWidth:number;cardWidth:number;cardHeight:number}>('(()=>{const card=document.querySelector("[data-shared-item]"),cover=card.querySelector(".collection-cover");const a=card.getBoundingClientRect(),b=cover.getBoundingClientRect();return{coverWidth:b.width,cardWidth:a.width,cardHeight:a.height}})()')
      assert(restoredList.coverWidth<=76&&restoredList.cardWidth>restoredList.cardHeight*3)
      report.sharedListViewRestored=true
      report.positionsAndPreferencesRestored=true;report.matchCacheRestored=Boolean(db.getMatch({collectionId:db.getCollections()[0]!.id,position:7},createHash('sha256').update(JSON.stringify(db.getOriginal({collectionId:db.getCollections()[0]!.id,position:7}))).digest('hex')))
      assert.equal(report.matchCacheRestored,true)
      report.passed=true;return
    }
    await set({currentPage:'library',theme:'day'})
    await click('[data-share-import] summary');await input('[data-share-link]',playlist.originalUrl);await input('[data-share-name]',playlist.name)
    await click('[data-share-submit]');await wait('document.querySelectorAll(".track-table tbody tr").length === 22')
    await wait('document.querySelector("[data-first-track-cover]")?.complete && document.querySelector("[data-first-track-cover]")?.naturalWidth > 0')
    report.firstTrackCoverDisplayed=true
    assert.deepEqual(db.getCollection(db.getCollections()[0]!.id)!.tracks.map(item=>item.title),playlist.tracks.map(item=>item.title))
    seedObservedCache(db,root)
    await capture('day-imported-cover')
    await click('.back-button');await wait('Boolean(document.querySelector("[data-shared-item] [data-first-track-cover]"))')
    await click('[data-view="grid"]')
    await wait('document.querySelector("[data-view=grid]").getAttribute("aria-pressed")==="true"')
    const sharedGeometry=async():Promise<{coverWidth:number;cardWidth:number;cardHeight:number;name:string;imageWidth:number}> => evaluate('(()=>{const card=document.querySelector("[data-shared-item]"),cover=card.querySelector(".collection-cover"),image=cover.querySelector("img");const a=card.getBoundingClientRect(),b=cover.getBoundingClientRect();return{coverWidth:b.width,cardWidth:a.width,cardHeight:a.height,name:card.querySelector(".collection-name").textContent,imageWidth:image?.naturalWidth??0}})()')
    const grid=await sharedGeometry()
    assert(grid.coverWidth>150&&grid.cardHeight>grid.cardWidth/2&&grid.imageWidth>0)
    const gridPresentation=async():Promise<{fit:string;leftDifference:number;rightDifference:number;imageWidth:number;imageHeight:number;frameWidth:number;frameHeight:number;dockTop:number;frameBottom:number;nameFits:boolean}>=>evaluate('(()=>{const card=document.querySelector("[data-shared-item]"),cover=card.querySelector(".collection-cover"),image=cover.querySelector("img"),dock=card.querySelector(".collection-dock"),name=card.querySelector(".collection-name");const a=cover.getBoundingClientRect(),b=dock.getBoundingClientRect(),c=image.getBoundingClientRect();const scale=Math.min(c.width/image.naturalWidth,c.height/image.naturalHeight);return{fit:getComputedStyle(image).objectFit,leftDifference:Math.abs(a.left-b.left),rightDifference:Math.abs(a.right-b.right),imageWidth:image.naturalWidth*scale,imageHeight:image.naturalHeight*scale,frameWidth:a.width,frameHeight:a.height,dockTop:b.top,frameBottom:a.bottom,nameFits:name.scrollWidth<=name.clientWidth}})()')
    const checkPresentation=async():Promise<void>=>{
      const item=await gridPresentation()
      assert.equal(item.fit,'contain');assert(item.leftDifference<1&&item.rightDifference<1)
      assert(item.imageWidth<=item.frameWidth&&item.imageHeight<=item.frameHeight&&item.dockTop>=item.frameBottom-1)
      assert(item.nameFits)
    }
    await checkPresentation()
    await capture('day-share-grid')
    for(const [shape,width,height] of [['landscape',1200,720],['portrait',720,1080]] as const){
      const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#A7BDC8"/><rect x="10" y="10" width="${width-20}" height="${height-20}" fill="none" stroke="#17252F" stroke-width="12"/><text x="40" y="90" font-family="sans-serif" font-size="38" fill="#17252F">${shape.toUpperCase()} / LAYOUT CHECK</text></svg>`
      const address='data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64')
      await evaluate('document.querySelector("[data-shared-item] .collection-cover img").src='+JSON.stringify(address))
      await wait(`document.querySelector("[data-shared-item] .collection-cover img").naturalWidth===${width}`)
      await checkPresentation()
    }
    const longTitle='Summer Pockets Original Soundtrack · 長い日本語の歌单名与完整封面布局验证'
    await evaluate('document.querySelector("[data-shared-item] .collection-name").textContent='+JSON.stringify(longTitle))
    await checkPresentation()
    const picture=db.getSetting<{firstHash:string;imageKey:string}>('collection-cover:'+db.getCollections()[0]!.id,{firstHash:'',imageKey:''})
    await evaluate('document.querySelector("[data-shared-item] .collection-cover img").src='+JSON.stringify('su-music://app/cover/'+picture.imageKey+'.jpg')+';document.querySelector("[data-shared-item] .collection-name").textContent='+JSON.stringify(grid.name))
    await wait('document.querySelector("[data-shared-item] .collection-cover img").complete&&document.querySelector("[data-shared-item] .collection-cover img").naturalWidth===500')
    report.gridFullImagesAndDockAlignmentVerified=true
    report.nonSquareImagesAndLongNamesVerified=true
    await click('[data-view="list"]')
    await wait('document.querySelector("[data-view=list]").getAttribute("aria-pressed")==="true"')
    const list=await sharedGeometry()
    assert(list.coverWidth<=76&&list.cardWidth>list.cardHeight*3&&list.imageWidth>0)
    assert.equal(list.name,grid.name);assert(list.cardHeight<grid.cardHeight/2)
    await capture('day-share-list')
    await set({theme:'night'});await capture('night-share-list')
    await click('[data-view="grid"]');await capture('night-share-grid')
    assert((await sharedGeometry()).coverWidth>150)
    report.sharedGridAndListGeometryVerified=true
    report.firstTrackCoverRetainedInBothViews=true
    await set({theme:'day'});await capture('day-share-overview')
    await click('[data-shared-item]');await wait('document.querySelectorAll(".track-table tbody tr").length === 22')
    report.realFixturePositionsPreserved=true;report.shareFormAndAsyncImportVerified=true
    await click('[data-match-position="7"]');await wait('document.querySelector("[data-match-status]")?.textContent.includes("需要对照版本")')
    assert((await evaluate<string>('document.querySelector(".comparison-candidate").textContent')).includes('58.371'))
    assert((await evaluate<string>('document.querySelector("[data-version-panel]").textContent')).includes('58.371'))
    assert.equal(await evaluate<boolean>('Boolean(document.querySelector("[data-resource-check]"))'),false)
    report.conflictShownWithoutAutomaticCandidate=true;await capture('day-conflict')
    await evaluate('window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape"}))');await wait('!document.querySelector("[data-version-panel]")')
    await set({theme:'night'});await click('[data-track-position="8"]');await click('[data-edit-version]');await wait('Boolean(document.querySelector("[data-resource-check]"))')
    await click('[data-resource-check]');await wait('document.querySelector("[data-resource-result]")?.textContent.includes("局部检查")')
    assert.equal(await evaluate<boolean>('(()=>{const a=document.querySelector("[data-resource-result]").getBoundingClientRect(),b=document.querySelector("[data-version-panel]").getBoundingClientRect();return a.top>=b.top&&a.bottom<=b.bottom+1})()'),true)
    assert((await evaluate<string>('document.querySelector("[data-resource-result]").textContent')).includes('局部读取记录，整曲播放另行记录'))
    assert.equal(await evaluate<boolean>('document.querySelector(".play-button").disabled'),true)
    report.partialResourceStatusSeparatedFromPlayback=true;await capture('night-resource')
    await click('[data-nav="search"]');await click('[data-search-scope="online"]');await input('[data-song-query]','Carefree');await click('[data-song-search]')
    await wait('document.querySelectorAll("[data-online-result]").length === 1');await capture('night-search')
    await click('[data-online-result] .playback-actions .button:last-child');await wait('document.querySelector("[data-version-panel]")?.textContent.includes("Carefree")')
    assert.equal(await evaluate<boolean>('Boolean(document.querySelector("[data-version-panel] [role=status]"))'),false)
    report.onlineSearchAndCandidatePanelVerified=true
    await click('[data-search-scope="library"]');await input('[data-song-query]','スパークル');await click('[data-song-search]')
    await wait('document.querySelectorAll(".search-results .song-result").length === 2')
    report.librarySearchPositionsVerified=true
    await click('.search-results .song-result .song-title-action');await wait('Boolean(document.querySelector("[data-match-status]"))')
    window.setSize(960,640);await delay(200);await capture('minimum-version-panel')
    assert.equal(await evaluate<boolean>('document.documentElement.scrollWidth>innerWidth||document.querySelector(".content").scrollWidth>document.querySelector(".content").clientWidth'),false)
    report.minimumWindowNoOuterOverflow=true
    await set({theme:'night',density:'compact',libraryView:'list',currentPage:'settings'})
    report.passed=true
  } catch(error) { report.passed=false;report.error=error instanceof Error?error.message:'P1_SMOKE_FAILED';throw error }
  finally { fs.writeFileSync(path.join(root,'report-'+phase+'.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report)) }
}
