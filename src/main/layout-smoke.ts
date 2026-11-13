import {app,screen} from 'electron'
import type {BrowserWindow} from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {performance} from 'node:perf_hooks'
import {setTimeout as delay} from 'node:timers/promises'
import type {MusicDatabase} from './database.ts'
import type {PlayerController} from './player/controller.ts'
import type {AccountLibrary} from '../shared/account.ts'
import type {SourceCandidate} from '../shared/music.ts'
import {candidateKey} from '../shared/music.ts'
import {matchCandidates} from './music/matching.ts'
import {generatedWav} from './playback-smoke.ts'
import {PublicHttpClient} from './music/http.ts'
import type {FetchFunction} from './music/http.ts'
import {byteRange} from './player/media.ts'
import {registerLocalFile} from './player/local.ts'
import type {KugouOperation,KugouTransport} from './account/protocol.ts'
import {AccountError} from './account/protocol.ts'

const OWNER={id:'87654321',nickname:'P4 综合验证账号'}
const LONG='長い日本語の曲名と中文歌名用于检查完整显示・Original recording'
const PLAYABLE:SourceCandidate={providerId:'gd',sourceId:'netease',trackId:'700001',title:LONG,artists:['P4 验证歌手'],album:'P4 综合验证原声带',aliases:[],durationMs:180000,metadataComplete:true}
const ALTERNATIVE:SourceCandidate={...PLAYABLE,trackId:'700003',title:'选定的替代版本 (Movie edit)',artists:['P4 所选歌手'],album:'选定版本专辑',durationMs:6000}
const BAD:SourceCandidate={...PLAYABLE,trackId:'700002',title:'暂不可用的验证歌曲'}
const libraries=new Map<string,AccountLibrary>(),requests=new Map<string,{source:number;audio:number;account:number}>()
const hash=(value:string)=>createHash('md5').update(value).digest('hex')

function syntheticLibrary():AccountLibrary{
  const collections=Array.from({length:120},(_,index)=>{
    const kind=index<2?'default' as const:index<82?'created' as const:'favorite' as const
    const count=index===0?0:index===1?5000:12
    const tracks=Array.from({length:count},(_,offset)=>{
      const position=offset+1,special=index===1&&position<=5,title=special&&position!==4?PLAYABLE.title:position===4&&index===1?BAD.title:`${LONG} · ${index+1}-${position}`
      const value=hash(index+':'+(index===1&&position===2?1:position))
      return{position,title,filename:'P4 验证歌手 - '+title+'.mp3',artist:'P4 验证歌手',album:PLAYABLE.album,durationMs:PLAYABLE.durationMs,version:null,hash:value,raw:{hash:value,songname:title,name:'P4 验证歌手 - '+title+'.mp3',timelen:PLAYABLE.durationMs,singerinfo:[{name:'P4 验证歌手'}],albuminfo:{name:PLAYABLE.album}}}
    })
    return{sourceKey:JSON.stringify([kind==='favorite'?1:0,String(index+1)]),sourceGlobalKey:null,name:index===0?'默认收藏':index===1?'我喜欢 · 大型歌单':`P4 ${kind==='created'?'自建':'收藏'} ${String(index+1).padStart(3,'0')} · 长歌单名と日本語の表示確認`,kind,subtype:kind==='favorite'?'album' as const:null,order:index,reportedCount:count,raw:{listid:index+1,type:kind==='favorite'?1:0,source:kind==='favorite'?2:1,is_def:index<2?index+1:0,name:index===0?'默认收藏':index===1?'我喜欢 · 大型歌单':`P4 集合 ${index+1}`,count},tracks}
  })
  return{owner:OWNER,at:new Date().toISOString(),collections,rawDirectoryCount:collections.length,unknownClassifications:0,directoryVerified:true}
}
export function p4MockFetch(root:string):FetchFunction{
  if(!requests.has(root))requests.set(root,{source:0,audio:0,account:0})
  return async(input,options)=>{
    const url=new URL(String(input)),headers=new Headers(options?.headers),observed=requests.get(root)!
    assert.equal(options?.credentials,'omit');assert(!headers.has('cookie')&&!headers.has('authorization'))
    if(url.hostname==='music-api.gdstudio.xyz'){
      if(url.searchParams.get('types')!=='url')throw new Error('P4_UNEXPECTED_SEARCH_REQUEST')
      observed.source++;const id=url.searchParams.get('id')
      if(id===BAD.trackId)return new Response(JSON.stringify({url:'',br:-1}))
      if(id!==PLAYABLE.trackId&&id!==ALTERNATIVE.trackId)throw new Error('P4_UNEXPECTED_RESOURCE_ID')
      return new Response(JSON.stringify({url:'https://m8.music.126.net/p4-'+id+'.wav',br:128}))
    }
    if(url.hostname==='m8.music.126.net'){
      const id=/^\/p4-(700001|700003)\.wav$/.exec(url.pathname)?.[1];if(!id)throw new Error('P4_UNEXPECTED_AUDIO_ID')
      observed.audio++;const data=generatedWav(id===PLAYABLE.trackId?PLAYABLE.durationMs!:6000),bounds=byteRange(headers.get('range'),data.length),body=bounds?data.subarray(bounds.start,bounds.end+1):data
      const result:Record<string,string>={'Content-Type':'audio/wav','Content-Length':String(body.length),'Accept-Ranges':'bytes'}
      if(bounds)result['Content-Range']=`bytes ${bounds.start}-${bounds.end}/${data.length}`
      return new Response(options?.method==='HEAD'?null:new Uint8Array(body),{status:bounds?206:200,headers:result})
    }
    throw new Error('P4_NO_EXTERNAL_NETWORK')
  }
}
export function p4MockHttp(root:string):PublicHttpClient{return new PublicHttpClient(p4MockFetch(root))}
export function seedP4Smoke(db:MusicDatabase,root:string,phase:string):void{
  const library=syntheticLibrary();libraries.set(root,library)
  if(phase==='first')db.replaceAccountLibrary(library)
  for(const candidate of [PLAYABLE,ALTERNATIVE,BAD])db.setSourceCache('candidate',candidateKey(candidate),candidate,86400000)
  const favorites=db.getCollections().find(item=>item.positionCount===5000)!
  for(const position of [1,2,3,4,5]){
    const reference={collectionId:favorites.id,position},original=db.getOriginal(reference)!,candidate=position===4?BAD:PLAYABLE
    db.saveMatch(reference,db.originalSignature(reference)!,matchCandidates(original,[candidate,ALTERNATIVE]))
  }
  if(phase==='first'){
    const reference={collectionId:favorites.id,position:3}
    db.saveBinding(reference,'alternative',{target:{kind:'candidate',candidate:{providerId:'gd',sourceId:'netease',trackId:ALTERNATIVE.trackId}},candidate:ALTERNATIVE})
    const audio=path.join(root,'fixtures','p4-local.wav');fs.mkdirSync(path.dirname(audio),{recursive:true});fs.writeFileSync(audio,generatedWav(6000));registerLocalFile(db,audio)
    db.setIssue({collectionId:favorites.id,position:6},'验证用资源暂不可用，可选择其他版本。')
    db.setPinned(favorites.id,true)
  }
}
export class P4Transport implements KugouTransport{
  private root:string
  constructor(root:string){this.root=root}
  async call(operation:KugouOperation,_context:unknown,params:Record<string,string|number>={},signal?:AbortSignal):Promise<Record<string,unknown>>{
    if(signal?.aborted)throw new AccountError('ACCOUNT_CANCELLED')
    requests.get(this.root)!.account++
    let mode='full';try{mode=JSON.parse(fs.readFileSync(path.join(this.root,'account-mode.json'),'utf8')).mode}catch{}
    if(mode==='timeout')throw new AccountError('ACCOUNT_TIMEOUT')
    if(operation==='identity')return{status:1,data:{userid:OWNER.id,nickname:OWNER.nickname}}
    if(operation==='qr_key')return{status:1,data:{qrcode:'p4-synthetic-qr'}}
    if(operation==='qr_check')return{status:1,data:{status:1}}
    const library=libraries.get(this.root)!
    if(operation==='directory'){
      const page=Number(params.page),rows=library.collections.slice((page-1)*100,page*100).map((collection,index)=>({...collection.raw as Record<string,unknown>,name:collection.name,count:collection.reportedCount}))
      return{status:1,data:{userid:OWNER.id,list_count:library.collections.length,total_ver:1,info:rows}}
    }
    const collection=library.collections[Number(params.listid)-1]!,page=Number(params.page),size=Number(params.pagesize)
    return{status:1,data:{userid:OWNER.id,listid:params.listid,count:collection.tracks.length,page,pagesize:size,list_ver:1,info:collection.tracks.slice((page-1)*size,page*size).map(track=>track.raw)}}
  }
}
export async function runP4Smoke(window:BrowserWindow,db:MusicDatabase,player:PlayerController,phase:string,scale:number):Promise<void>{
  const root=path.dirname(app.getPath('userData')),began=performance.now(),functional=process.argv.includes('--layout-functional')
  const report:Record<string,unknown>={at:new Date().toISOString(),phase,testProtocol:2,suite:'layout',functional,packaged:app.isPackaged,scale,scaleMethod:'Chromium --force-device-scale-factor on Windows; OS global settings unchanged',environment:{system:process.getSystemVersion(),arch:process.arch,release:os.release(),electron:process.versions.electron,node:process.versions.node,sqlite:db.sqliteVersion()},sourceMode:'synthetic account and audio responses; no real account or external network',schemaVersion:db.schemaVersion(),scenes:[],timings:[],passed:false}
  const evaluate=async<T>(code:string):Promise<T>=>{try{return await window.webContents.executeJavaScript(code,true) as T}catch(error){throw new Error('P4_RENDERER_STEP: '+code.slice(0,180),{cause:error})}}
  const wait=async(code:string,timeout=20000):Promise<void>=>{const end=Date.now()+timeout;while(Date.now()<end){if(await evaluate<boolean>(code))return;await delay(40)}throw new Error('P4_UI_WAIT_TIMEOUT: '+code.slice(0,100))}
  const click=async(selector:string):Promise<void>=>{await evaluate('document.querySelector('+JSON.stringify(selector)+').click()');await delay(80)}
  const set=async(value:unknown):Promise<void>=>{assert.equal((await evaluate<{ok:boolean}>('window.suMusic.setPreferences('+JSON.stringify(value)+')')).ok,true);await delay(80)}
  const input=async(selector:string,value:string):Promise<void>=>{await evaluate('(()=>{const input=document.querySelector('+JSON.stringify(selector)+');input.value='+JSON.stringify(value)+';input.dispatchEvent(new Event("input",{bubbles:true}))})()');await delay(80)}
  const sort=async(value:string):Promise<void>=>{await evaluate('(()=>{const input=document.querySelector("[aria-label=\\"歌单排序\\"]");input.value='+JSON.stringify(value)+';input.dispatchEvent(new Event("change",{bubbles:true}))})()');await delay(100)}
  const names=():Promise<string[]>=>evaluate('Array.from(document.querySelectorAll("[data-collections] .collection-name"),item=>item.textContent.trim())')
  const key=async(keyCode:string,modifiers:NonNullable<Electron.KeyboardInputEvent['modifiers']>=[]):Promise<void>=>{window.webContents.focus();window.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});window.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await delay(100)}
  const capture=async(name:string):Promise<void>=>{
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await delay(200)
    for(let attempt=0;attempt<3;attempt++)try{const screenshot=await window.webContents.capturePage();assert(!screenshot.isEmpty(),'P4_EMPTY_SCREENSHOT');fs.writeFileSync(path.join(root,name+'.png'),screenshot.toPNG());return}catch(error){if(attempt===2)throw error;await delay(400)}
  }
  const layout=async(label:string):Promise<void>=>{
    const value=await evaluate<{width:number;height:number;dpr:number;outerOverflow:boolean;contentOverflow:boolean;footerVisible:boolean;accent:string;yellowText:boolean}>(`(()=>{
      const content=document.querySelector('.content'),footer=document.querySelector('.player'),r=footer.getBoundingClientRect();
      const controls=Array.from(footer.querySelectorAll('button,input')).filter(e=>!e.disabled);
      const inFooter=controls.every(e=>{const a=e.getBoundingClientRect();return a.left>=r.left-1&&a.right<=r.right+1&&a.top>=r.top-1&&a.bottom<=r.bottom+1});
      const accent=getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      const yellowText=Array.from(document.querySelectorAll('button')).every(e=>{const s=getComputedStyle(e);return s.backgroundColor!=='rgb(255, 250, 0)'||s.color==='rgb(11, 12, 14)'});
      return{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,outerOverflow:document.documentElement.scrollWidth>innerWidth+1,contentOverflow:content.scrollWidth>content.clientWidth+1,footerVisible:r.left>=-1&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1&&inFooter,accent,yellowText};})()`)
    ;(report.scenes as unknown[]).push({label,...value});assert(!value.outerOverflow,'P4_OUTER_OVERFLOW '+label);assert(!value.contentOverflow,'P4_CONTENT_OVERFLOW '+label);assert(value.footerVisible,'P4_FOOTER_CLIPPED '+label);assert(value.yellowText,'P4_ACCENT_TEXT '+label);assert.equal(value.accent.toUpperCase(),'#FFFA00');assert(Math.abs(value.dpr-scale)<0.02,'P4_DEVICE_SCALE')
  }
  try{
    await wait('document.body.dataset.ready==="true"')
    const bounds=window.getBounds(),workArea=screen.getDisplayMatching(bounds).workArea
    report.initialWindow={bounds,workArea};report.initialWindowFitsDisplay=bounds.x>=workArea.x-8&&bounds.y>=workArea.y-8&&bounds.x+bounds.width<=workArea.x+workArea.width+8&&bounds.y+bounds.height<=workArea.y+workArea.height+8
    assert(report.initialWindowFitsDisplay,'P4_INITIAL_WINDOW_OUTSIDE_WORK_AREA');await layout('startup-work-area')
    const collections=db.getCollections(),large=collections.find(item=>item.positionCount===5000)!,empty=collections.find(item=>item.positionCount===0)!
    assert.equal(collections.length,120);report.collectionCount=collections.length;report.positionCount=collections.reduce((sum,item)=>sum+item.positionCount,0);report.displayScale=screen.getPrimaryDisplay().scaleFactor
    if(phase==='resume'){
      await set({currentPage:'library'});await click('.pinned-item');await wait('document.querySelectorAll(".track-table tbody tr").length===5000');assert.equal(db.getCollection(large.id)!.tracks[2]!.title,ALTERNATIVE.title);await layout('resume-large-detail');report.largeLibraryAndSelectedRowRestored=true;report.passed=true;return
    }
    window.setSize(1280,820);await set({currentPage:'library',theme:'day',volume:0,libraryView:'grid',librarySort:'recent'})
    await wait('document.querySelectorAll("[data-collections] .collection-card").length===120');await layout('large-overview-1280');await capture('day-large-overview')
    for(const view of ['list','grid']){await click('[data-view="'+view+'"]');if(functional)assert.deepEqual((await names()).sort(),collections.map(item=>item.name).sort());await layout('large-overview-'+view)}
    if(functional){
    report.gridAndListContentsAgree=true
    for(const [tab,kind,count] of [[2,'default',2],[3,'created',80],[4,'favorite',38],[1,'all',120]] as const){
      await click('.category-tabs button:nth-child('+tab+')');await wait('document.querySelectorAll("[data-collections] .collection-card").length==='+count)
      assert.equal(await evaluate<string>('document.querySelector(".category-tabs button:nth-child('+tab+') .tab-count").textContent'),String(count))
      assert.deepEqual((await names()).sort(),collections.filter(item=>kind==='all'||item.kind===kind).map(item=>item.name).sort());await layout('category-'+kind)
    }
    const byName=new Map(collections.map(item=>[item.name,item.positionCount]))
    for(const order of ['name','count','recent']){
      await sort(order);const shown=await names();assert.equal(shown.length,120)
      if(order==='name')assert(await evaluate<boolean>('Array.from(document.querySelectorAll("[data-collections] .collection-name"),item=>item.textContent.trim()).every((name,index,all)=>index===0||all[index-1].localeCompare(name,"zh-CN")<=0)'))
      if(order==='count'){const counts=shown.map(name=>byName.get(name)!);assert(counts.every((count,index)=>index===0||counts[index-1]!>=count));assert.equal(shown[0],large.name);assert.equal(shown.at(-1),empty.name)}
      await layout('sort-'+order)
    }
    report.categoriesAndSortOrderCorrect=true
    }
    await sort('count');await click('.category-tabs button:nth-child(2)')
    await input('[aria-label="筛选歌单名称"]','大型歌单');await wait('document.querySelectorAll("[data-collections] .collection-card").length===1')
    const opened=performance.now();await click('[data-collections] .collection-card');await wait('document.querySelectorAll(".track-table tbody tr").length===5000');const renderedMs=performance.now()-opened
    ;(report.timings as unknown[]).push({operation:'open 5000-row playlist including IPC and render',elapsedMs:Math.round(renderedMs)});if(functional)assert(renderedMs<8000,'P4_LARGE_RENDER_TOO_SLOW')
    await evaluate('document.querySelector("[data-track-position=\\"5000\\"]").scrollIntoView({block:"center"})');await layout('last-track-visible');await capture('day-last-track')
    await click('.back-button');if(functional){assert.equal(await evaluate<string>('document.querySelector("[aria-label=\\"筛选歌单名称\\"]").value'),'大型歌单');assert.equal(await evaluate<string>('document.querySelector("[aria-label=\\"歌单排序\\"]").value'),'count');assert.equal(await evaluate<string>('document.querySelector(".category-tabs button:nth-child(2)").getAttribute("aria-pressed")'),'true');assert.equal(await evaluate<string>('document.querySelector("[data-view=grid]").getAttribute("aria-pressed")'),'true');report.collectionFilterAndDetailReturn=true}
    await input('[aria-label="筛选歌单名称"]','');await sort('recent');if(functional){assert.equal((await names())[0],large.name);report.recentSortTracksOpenedCollection=true;}await click('.category-tabs button:nth-child(1)');await click('.pinned-item');await wait('document.querySelectorAll(".track-table tbody tr").length===5000')
    if(functional){
    const queries=performance.now();assert.equal((await evaluate<{ok:boolean}>('window.suMusic.searchLibrary("'+LONG.slice(0,8)+'")')).ok,true);(report.timings as unknown[]).push({operation:'search 6416 song positions',elapsedMs:Math.round(performance.now()-queries)})
    assert.equal(requests.get(root)!.source,0);report.libraryBrowsingDoesNotResolveAudio=true
    }
    await click('[data-row-play="1"]');await wait('document.querySelector("[data-audio]")?.currentTime>0.15&&!document.querySelector("[data-audio]")?.paused')
    const token=player.snapshot().media!.id
    for(const theme of ['day','night'] as const){
      await set({theme})
      for(const page of ['library','search','history','review','local','settings','now']){
        if(page==='library')await click('[data-nav="library"]');else if(page==='now')await click('[data-now]');else await click('[data-nav="'+page+'"]')
        if(page==='settings')await evaluate('document.querySelector(".cache-settings").scrollIntoView({block:"start"})')
        await layout(theme+'-'+page+'-1280')
      }
      await capture(theme+'-now-playing')
      await click('[data-queue]');await layout(theme+'-queue-1280');await capture(theme+'-queue');await key('Escape');assert.equal(await evaluate<boolean>('Boolean(document.querySelector(".queue-panel"))'),false)
    }
    report.playingLayoutsAcrossAllPagesAndThemes=true
    await click('[data-nav="library"]');await click('.pinned-item');await click('[data-track-position="3"]');await click('[data-edit-version]');await wait('Boolean(document.querySelector("[data-version-panel] [data-use-remember]"))')
    await layout('version-panel-1280');await capture('night-version-panel');await key('Escape')
    window.setSize(960,640);await delay(150)
    for(const theme of ['day','night'] as const){await set({theme});for(const page of ['library','search','history','review','local','settings','now']){await set({currentPage:page});await layout(theme+'-'+page+'-minimum')}await capture(theme+'-minimum')}
    await click('[data-queue]');await layout('queue-minimum');await key('Escape');await set({currentPage:'library'});await click('[data-track-position="3"]');await click('[data-edit-version]');await delay(100);await layout('version-minimum');await capture('version-minimum');await key('Escape')
    if(functional){
    await key('k',['control']);await wait('document.querySelector("[data-nav=\\"search\\"]").getAttribute("aria-current")==="page"');report.searchShortcut=true
    await click('[data-nav="library"]');await click('.pinned-item');await evaluate('document.querySelector("[data-track-position=\\"1\\"]").focus()');await key('Space');await wait('document.querySelector("[data-audio]").paused');await key('Space');await wait('!document.querySelector("[data-audio]").paused');report.spacePlaybackShortcut=true
    await key('Enter');await wait('document.querySelector("[data-audio]").currentTime>0.15&&!document.querySelector("[data-audio]").paused');assert.notEqual(player.snapshot().media!.id,token);const current=player.snapshot().queue.find(item=>item.id===player.snapshot().currentId)!;assert.equal(current.target.kind,'original');if(current.target.kind==='original')assert.equal(current.target.reference.position,1);report.enterSongRowPlays=true
    await key('Tab');assert.equal(await evaluate<boolean>('document.activeElement instanceof HTMLButtonElement||document.activeElement instanceof HTMLInputElement'),true);report.tabReachesInteractiveControls=true
    }
    await evaluate('window.suMusic.playerCommand({type:"control",action:"stop"})');await wait('document.querySelector("[data-audio]").paused')
    await set({currentPage:'settings'});await click('[data-notices]');await wait('document.querySelector("dialog").open');await layout('license-dialog-minimum');if(functional){const notices=await evaluate<string>('document.querySelector("dialog pre").textContent');assert(notices.includes('qrcode')&&notices.includes('electron'))}await key('Escape');await wait('!document.querySelector("dialog").open');report.licensesKeyboardDismissed=true
    await click('[data-nav="library"]');await click('[data-view="list"]');await input('[aria-label="筛选歌单名称"]','默认收藏');await click('[data-collections] .collection-card');await wait('document.querySelector(".empty-inline")?.textContent.includes("没有曲目")');await layout('empty-playlist-minimum');report.emptyCollectionHasClearState=true
    await set({theme:'night',density:'compact',libraryView:'list',currentPage:'settings',volume:0});report.requestCounts=requests.get(root);report.elapsedMs=Math.round(performance.now()-began);report.passed=true
  }catch(error){report.error=error instanceof Error?error.message:'P4_SMOKE_FAILED';report.state={phase:player.snapshot().phase,reason:player.snapshot().reason};throw error}
  finally{report.elapsedMs=Math.round(performance.now()-began);report.requestCounts=requests.get(root);fs.writeFileSync(path.join(root,'report-'+phase+'.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({p4SmokePassed:report.passed,phase,scale,error:report.error??null,scenes:(report.scenes as unknown[]).length}))}
}
