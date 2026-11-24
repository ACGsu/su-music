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
import {metadataSmokeResponse} from './metadata-smoke.ts'

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
      const position=offset+1,special=index===1&&(position<=5||position===2500),title=special&&position!==4?PLAYABLE.title:position===4&&index===1?BAD.title:`${LONG} · ${index+1}-${position}`
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
    const metadata=metadataSmokeResponse(url);if(metadata)return metadata
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
  for(const position of [1,2,3,4,5,2500]){
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
  const click=async(selector:string):Promise<void>=>{
    if(selector.startsWith('[data-nav')&&!await evaluate<boolean>('Boolean(document.querySelector(".sidebar"))')){await evaluate('document.querySelector("[data-now-back]").click()');await delay(100)}
    await evaluate('document.querySelector('+JSON.stringify(selector)+').click()');await delay(80)
  }
  const set=async(value:unknown):Promise<void>=>{assert.equal((await evaluate<{ok:boolean}>('window.suMusic.setPreferences('+JSON.stringify(value)+')')).ok,true);await delay(80)}
  const input=async(selector:string,value:string):Promise<void>=>{await evaluate('(()=>{const input=document.querySelector('+JSON.stringify(selector)+');input.value='+JSON.stringify(value)+';input.dispatchEvent(new Event("input",{bubbles:true}))})()');await delay(80)}
  const sort=async(value:string):Promise<void>=>{await evaluate('(()=>{const input=document.querySelector("[aria-label=\\"歌单排序\\"]");input.value='+JSON.stringify(value)+';input.dispatchEvent(new Event("change",{bubbles:true}))})()');await delay(100)}
  const names=():Promise<string[]>=>evaluate('Array.from(document.querySelectorAll("[data-collections] .collection-name"),item=>item.textContent.trim())')
  const key=async(keyCode:string,modifiers:NonNullable<Electron.KeyboardInputEvent['modifiers']>=[]):Promise<void>=>{window.focus();window.webContents.focus();window.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});if(keyCode==='Enter')window.webContents.sendInputEvent({type:'char',keyCode:'Enter',modifiers});window.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await delay(100)}
  const point=async(selector:string):Promise<{x:number;y:number}>=>evaluate('(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return{x:Math.round((r.left+r.right)/2),y:Math.round((r.top+r.bottom)/2)}})()')
  const nativeClick=async(selector:string):Promise<void>=>{
    const {x,y}=await point(selector);window.focus();window.webContents.focus();window.webContents.sendInputEvent({type:'mouseMove',x,y});await delay(180)
    window.webContents.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});window.webContents.sendInputEvent({type:'mouseUp',x,y,button:'left',clickCount:1});await delay(150)
  }
  const capture=async(name:string):Promise<void>=>{
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await delay(200)
    for(let attempt=0;attempt<3;attempt++)try{const screenshot=await window.webContents.capturePage();assert(!screenshot.isEmpty(),'P4_EMPTY_SCREENSHOT');fs.writeFileSync(path.join(root,name+'.png'),screenshot.toPNG());return}catch(error){if(attempt===2)throw error;await delay(400)}
  }
  const layout=async(label:string):Promise<void>=>{
    assert(await evaluate<boolean>('(()=>{const nav=document.querySelector("[data-playlist-navigation]");if(!nav)return true;const frame=document.querySelector(".content-frame").getBoundingClientRect(),content=document.querySelector(".content").getBoundingClientRect(),buttons=Array.from(nav.querySelectorAll("button")),boxes=buttons.map(e=>e.getBoundingClientRect());const usable=buttons.every((e,i)=>{const r=boxes[i],hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);return r.left>=frame.left&&r.right<=frame.right&&r.top>=frame.top&&r.bottom<=frame.bottom&&(getComputedStyle(e).pointerEvents==="auto"?e.contains(hit):!e.contains(hit))});const clear=Array.from(document.querySelectorAll(".state-cell button")).every(e=>{const r=e.getBoundingClientRect(),clip=e.closest(".track-table-wrap").getBoundingClientRect(),left=Math.max(r.left,clip.left),right=Math.min(r.right,clip.right);if(right<=left||r.bottom<=content.top||r.top>=content.bottom)return true;return r.left>=clip.left-1&&r.right<=clip.right+1&&boxes.every(b=>right<=b.left||left>=b.right||r.bottom<=b.top||r.top>=b.bottom)});return usable&&clear})()'),'P4_PLAYLIST_NAVIGATION '+label)
    assert(await evaluate<boolean>(`(()=>{
      return Array.from(document.querySelectorAll('.pinned-item')).every(button=>{
        const name=button.querySelector('.pinned-name'),marker=button.querySelector('.pin-marker');if(!name||!marker)return false;
        const original=name.textContent,style=getComputedStyle(name),before=name.getBoundingClientRect(),dot=marker.getBoundingClientRect(),markStyle=getComputedStyle(marker),bounds=button.getBoundingClientRect();
        if(button.title!==original||style.whiteSpace!=='nowrap'||style.textOverflow!=='ellipsis'||style.overflow!=='hidden')return false;
        if(before.width<=0||dot.left<before.right||dot.right>bounds.right||dot.top<bounds.top||dot.bottom>bounds.bottom||dot.width<4||dot.width>8||Math.abs(dot.width-dot.height)>0.25)return false;
        if(markStyle.backgroundColor!=='rgb(255, 250, 0)'||parseFloat(markStyle.borderTopWidth)!==0||(markStyle.borderRadius!=='50%'&&parseFloat(markStyle.borderRadius)<dot.width/2))return false;
        try{
          for(const text of ['超长置顶歌单名称'.repeat(20),'VeryLongPlaylistWithoutSpaces'.repeat(12),'中文 Mixed 日本語'.repeat(18)]){
            name.textContent=text;const after=name.getBoundingClientRect(),afterDot=marker.getBoundingClientRect();
            if(name.scrollWidth<=name.clientWidth||Math.abs(after.height-before.height)>0.25||Math.abs(afterDot.left-dot.left)>0.25||Math.abs(button.getBoundingClientRect().height-bounds.height)>0.25)return false;
          }
          return true;
        }finally{name.textContent=original;}
      });
    })()`),'P4_PINNED_SINGLE_LINE_AND_YELLOW_DOT '+label)
    assert(await evaluate<boolean>(`(()=>{const cover=document.querySelector('[data-now-cover-stage]');return !cover||cover.textContent.trim()==='';})()`),'P4_NOW_COVER_IMAGE_ONLY '+label)
    assert(await evaluate<boolean>(`(()=>{
      const rows=Array.from(document.querySelectorAll('tr[data-track-position]')).slice(0,8);
      for(const row of rows)for(const selector of ['[data-track-title]','[data-track-artist]']){
        const e=row.querySelector(selector),original=e.textContent,r=e.getBoundingClientRect(),s=getComputedStyle(e);
        if(r.width<=0||r.height>parseFloat(s.lineHeight)+1||e.parentElement.title!==original)return false;
        const rowHeight=row.getBoundingClientRect().height;e.textContent='超长中文と日本語 VeryLongNameWithoutSpaces '.repeat(20);
        const after=e.getBoundingClientRect(),ok=e.scrollWidth>e.clientWidth&&after.height<=parseFloat(s.lineHeight)+1&&Math.abs(row.getBoundingClientRect().height-rowHeight)<1;e.textContent=original;if(!ok)return false;
      }
      return true;
    })()`),'P4_TRACK_SINGLE_LINE '+label)
    assert(await evaluate<boolean>(`(()=>{
      const page=document.querySelector('[data-now-page]');if(!page)return true;
      const frame=document.querySelector('.content-frame').getBoundingClientRect(),content=document.querySelector('.content').getBoundingClientRect();
      if(document.querySelector('.sidebar')||Math.abs(frame.left)>1)return false;
      const lyrics=document.querySelector('[data-lyrics-scroll]');if(!lyrics)return true;
      const box=lyrics.getBoundingClientRect(),cover=document.querySelector('[data-now-cover-stage]'),queue=document.querySelector('[data-queue-panel]');
      if(box.width<100||box.height<60||box.top<content.top-1||box.bottom>content.bottom+1)return false;
      if((getComputedStyle(cover).display==='none')!==Boolean(queue))return false;
      if(queue)return box.right<=queue.getBoundingClientRect().left+1&&!queue.querySelector('[data-track-artwork]');
      const image=document.querySelector('.now-artwork').getBoundingClientRect();return Math.abs(image.width-image.height)<2&&image.top>=content.top&&image.bottom<=content.bottom;
    })()`),'P4_NOW_LYRICS_LAYOUT '+label)
    const value=await evaluate<{width:number;height:number;dpr:number;outerOverflow:boolean;contentOverflow:boolean;footerVisible:boolean;accent:string;yellowText:boolean}>(`(()=>{
      const content=document.querySelector('.content'),footer=document.querySelector('.player'),r=footer.getBoundingClientRect();
      const controls=Array.from(footer.querySelectorAll('button,input')).filter(e=>!e.disabled);
      const inFooter=controls.every(e=>{const a=e.getBoundingClientRect();return a.left>=r.left-1&&a.right<=r.right+1&&a.top>=r.top-1&&a.bottom<=r.bottom+1});
      const accent=getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      const yellowText=Array.from(document.querySelectorAll('button')).every(e=>{const s=getComputedStyle(e);return s.backgroundColor!=='rgb(255, 250, 0)'||s.color==='rgb(11, 12, 14)'});
      return{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,outerOverflow:document.documentElement.scrollWidth>innerWidth+1,contentOverflow:content.scrollWidth>content.clientWidth+1,footerVisible:r.left>=-1&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1&&inFooter,accent,yellowText};})()`)
    ;(report.scenes as unknown[]).push({label,...value});assert(!value.outerOverflow,'P4_OUTER_OVERFLOW '+label);assert(!value.contentOverflow,'P4_CONTENT_OVERFLOW '+label);assert(value.footerVisible,'P4_FOOTER_CLIPPED '+label);assert(value.yellowText,'P4_ACCENT_TEXT '+label);assert.equal(value.accent.toUpperCase(),'#FFFA00');assert(Math.abs(value.dpr-scale)<0.02,'P4_DEVICE_SCALE')
    assert(await evaluate<boolean>('Array.from(document.querySelectorAll(".progress input,.volume-control input")).every(e=>{const s=getComputedStyle(e),actual=parseFloat(s.getPropertyValue("--range-fill")),expected=Math.max(0,Math.min(100,Number(e.value)/Number(e.max)*100));return Math.abs(actual-expected)<0.1&&s.backgroundImage.includes("rgb(255, 250, 0)")})'),'P4_RANGE_FILL '+label)
    assert(await evaluate<boolean>(`(async()=>{
      const result=await window.suMusic.getState(),account=result.value.account??{};
      const expected=account.activeProvider==='netease'?Boolean(account.netease?.connected):account.kugou?.phase==='authenticated';
      const dot=document.querySelector('[data-account-dot]'),probe=document.createElement('span');
      if(!dot)return Boolean(document.querySelector('[data-now-page]'))&&!document.querySelector('.sidebar');
      probe.style.color='var(--muted)';document.body.append(probe);const gray=getComputedStyle(probe).color;probe.remove();
      return dot.classList.contains('connected')===expected&&getComputedStyle(dot).backgroundColor===(expected?'rgb(255, 250, 0)':gray);
    })()`),'P4_CONNECTION_DOT '+label)
  }
  const checkGridNames=async():Promise<void>=>{
    assert(await evaluate<boolean>('Array.from(document.querySelectorAll("[data-collections] .collection-name")).every(e=>{const s=getComputedStyle(e);return e.title===e.textContent&&s.whiteSpace==="nowrap"&&s.textOverflow==="ellipsis"&&s.overflow==="hidden"})'))
    for(const text of ['长歌单名称'.repeat(20),'VeryLongNameWithoutAnySpaces'.repeat(10),'中文 Mixed 日本語'.repeat(15)]){
      assert(await evaluate<boolean>('(()=>{const e=document.querySelector("[data-collections] .collection-name"),original=e.textContent;e.textContent='+JSON.stringify(text)+';const s=getComputedStyle(e),ok=e.scrollWidth>e.clientWidth&&e.clientHeight<=parseFloat(s.lineHeight)+22;e.textContent=original;return ok})()'))
    }
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
    for(const theme of ['day','night']){await set({theme});for(const size of [[1280,820],[960,640]]){window.setSize(size[0]!,size[1]!);await delay(100);await checkGridNames();await layout(theme+'-grid-ellipsis-'+size[0])}}
    window.setSize(1280,820);await set({theme:'day'})
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
    for(const theme of ['day','night']){
      await set({theme})
      for(const size of [[1280,820],[960,640]]){
        window.setSize(size[0]!,size[1]!);await delay(80)
        for(const text of ['超长专辑名称'.repeat(30),'LongAlbumWithoutAnySpaces'.repeat(20),'中文 Original Album 日本語'.repeat(20)]){
          assert(await evaluate<boolean>('(()=>{const e=document.querySelector("td .album-text"),original=e.textContent,originalTitle=e.title;e.textContent='+JSON.stringify(text)+';const s=getComputedStyle(e),ok=s.webkitLineClamp==="2"&&s.overflow==="hidden"&&e.getBoundingClientRect().height<=parseFloat(s.lineHeight)*2+1&&e.scrollHeight>e.clientHeight;e.textContent=original;return ok&&originalTitle===original})()'),'P4_ALBUM_ELLIPSIS')
        }
        await layout(theme+'-album-ellipsis-'+size[0])
      }
    }
    window.setSize(1280,820);await set({theme:'day'})
    await evaluate('document.querySelector("[data-track-position=\\"5000\\"]").scrollIntoView({block:"center"})');await layout('last-track-visible');await capture('day-last-track')
    await click('.back-button');if(functional){assert.equal(await evaluate<string>('document.querySelector("[aria-label=\\"筛选歌单名称\\"]").value'),'大型歌单');assert.equal(await evaluate<string>('document.querySelector("[aria-label=\\"歌单排序\\"]").value'),'count');assert.equal(await evaluate<string>('document.querySelector(".category-tabs button:nth-child(2)").getAttribute("aria-pressed")'),'true');assert.equal(await evaluate<string>('document.querySelector("[data-view=grid]").getAttribute("aria-pressed")'),'true');report.collectionFilterAndDetailReturn=true}
    await input('[aria-label="筛选歌单名称"]','');await sort('recent');if(functional){assert.equal((await names())[0],large.name);report.recentSortTracksOpenedCollection=true;}await click('.category-tabs button:nth-child(1)');await click('.pinned-item');await wait('document.querySelectorAll(".track-table tbody tr").length===5000')
    if(functional){
    const queries=performance.now();await input('[data-detail-filter-input]','5000');await wait('document.querySelectorAll(".track-table tbody tr").length===1');(report.timings as unknown[]).push({operation:'filter 5000-row playlist',elapsedMs:Math.round(performance.now()-queries)});await input('[data-detail-filter-input]','');await wait('document.querySelectorAll(".track-table tbody tr").length===5000')
    assert.equal(requests.get(root)!.source,0);report.libraryBrowsingDoesNotResolveAudio=true
    }
    await click('[data-row-play="1"]');await wait('document.querySelector("[data-audio]")?.currentTime>0.15&&!document.querySelector("[data-audio]")?.paused')
    const token=player.snapshot().media!.id
    assert(await evaluate<boolean>('!document.querySelector(".position-cell button")&&getComputedStyle(document.querySelector(".playing-track .position-cell span")).visibility!=="hidden"'))
    if(functional){
      const ids=player.snapshot().queue.map(item=>item.id),current=player.snapshot().currentId,before=await evaluate<number>('document.querySelector("[data-audio]").currentTime')
      await click('[data-row-play="1"]');await wait('document.querySelector("[data-audio]").paused')
      assert.equal(player.snapshot().media!.id,token);assert.equal(player.snapshot().currentId,current);assert.deepEqual(player.snapshot().queue.map(item=>item.id),ids)
      const paused=await evaluate<number>('document.querySelector("[data-audio]").currentTime');assert(paused>=before-0.05)
      assert.equal(await evaluate<boolean>('Boolean(document.querySelector(".inline-action-row"))'),false)
      await click('[data-row-play="1"]');await wait('!document.querySelector("[data-audio]").paused')
      assert.equal(player.snapshot().media!.id,token);assert((await evaluate<number>('document.querySelector("[data-audio]").currentTime'))>=paused-0.05)
      report.rowPlaybackTogglePreservesPositionAndQueue=true
      await click('[data-row-play="2500"]');await wait('document.querySelector(".playing-track")?.dataset.trackPosition==="2500"&&!document.querySelector("[data-audio]").paused')
      await evaluate('document.querySelector(".content").scrollTop=0');await click('[data-queue]')
      await wait('(()=>{const list=document.querySelector(".queue-list"),row=document.querySelector(".queue-current");if(!list||!row)return false;const a=list.getBoundingClientRect(),b=row.getBoundingClientRect();return list.scrollTop>0&&Math.abs((b.top+b.bottom)/2-(a.top+list.clientTop+list.clientHeight/2))<3})()')
      assert.equal(await evaluate<number>('document.querySelector(".content").scrollTop'),0)
      await evaluate('document.querySelector(".queue-list").scrollTop=0');await delay(250)
      assert.equal(await evaluate<number>('document.querySelector(".queue-list").scrollTop'),0)
      await click('[data-queue]');await click('[data-queue]');await wait('document.querySelector(".queue-list")?.scrollTop>0');await key('Escape')
      report.queueOpensCenteredAndRetainsManualScroll=true
      await input('[data-detail-filter-input]','5000');await wait('document.querySelectorAll(".track-table tbody tr[data-track-position]").length===1')
      await click('[data-locate-current]');await wait('document.querySelector("[data-detail-filter-input]").value===""&&document.querySelector(".located-track")?.dataset.trackPosition==="2500"')
      assert(await evaluate<boolean>('(()=>{const a=document.querySelector(".content").getBoundingClientRect(),c=document.querySelector(".content"),b=document.querySelector(".located-track").getBoundingClientRect();return Math.abs((b.top+b.bottom)/2-(a.top+c.clientTop+c.clientHeight/2))<3})()'))
      await layout('located-middle-track');await capture('located-middle-track');await click('[data-scroll-top]');await wait('document.querySelector(".content").scrollTop===0 && "dom-top"')
      await evaluate('document.querySelector(".content").scrollTop=document.querySelector(".content").scrollHeight');await delay(100)
      window.focus();window.webContents.focus();window.webContents.sendInputEvent({type:'mouseMove',x:2,y:2});await wait('getComputedStyle(document.querySelector("[data-playlist-navigation]")).opacity<0.5')
      const nav=await point('[data-scroll-top]');window.webContents.sendInputEvent({type:'mouseMove',x:nav.x-22,y:nav.y});await delay(180)
      await wait('getComputedStyle(document.querySelector("[data-playlist-navigation]")).opacity>0.95')
      assert(await evaluate<boolean>('(()=>{const r=document.querySelector("[data-scroll-top]").getBoundingClientRect(),hit=document.elementFromPoint(r.left-6,(r.top+r.bottom)/2);return !document.querySelector("[data-playlist-navigation]").contains(hit)})()'))
      await nativeClick('[data-scroll-top]');await wait('document.querySelector(".content").scrollTop===0 && "mouse-top"')
      await evaluate('document.querySelector(".content").scrollTop=1000');window.webContents.sendInputEvent({type:'mouseMove',x:2,y:2});await delay(180);await key('Tab');await evaluate('document.querySelector("[data-scroll-top]").focus()');await delay(180)
      await wait('getComputedStyle(document.querySelector("[data-playlist-navigation]")).opacity>0.95');await key('Enter');await wait('document.querySelector(".content").scrollTop===0 && "keyboard-top"');await evaluate('document.activeElement.blur()')
      report.playlistNavigationProximityPassThroughAndKeyboard=true
      report.playlistNavigationClearsHiddenFilterAndCenters=true
    }
    await evaluate('window.suMusic.playerCommand({type:"control",action:"pause"})');await delay(100)
    for(const percent of [0,50,100]){
      await set({volume:percent})
      await evaluate('(()=>{const e=document.querySelector("[data-seek]");e.value=String(Number(e.max)*'+percent+'/100);e.dispatchEvent(new Event("input",{bubbles:true}))})()');await delay(80)
      await layout('range-percent-'+percent)
    }
    if(functional){
      await set({volume:47});await evaluate('document.activeElement?.blur();document.body.focus()')
      await key('Up');await wait('document.querySelector("[data-volume]").value==="52"');assert.equal(db.getPreferences().volume,52)
      assert(Math.abs(await evaluate<number>('document.querySelector("[data-audio]").volume')-0.52)<0.0001)
      await key('Down');await wait('document.querySelector("[data-volume]").value==="47"')
      await input('[data-detail-filter-input]','5000');await evaluate('document.querySelector("[data-detail-filter-input]").focus()');await key('Up');assert.equal(await evaluate<string>('document.querySelector("[data-volume]").value'),'47');await input('[data-detail-filter-input]','')
      await evaluate('document.querySelector("[data-volume]").focus()');await key('Up');assert.equal(await evaluate<string>('document.querySelector("[data-volume]").value'),'52')
      await key('Down');assert.equal(await evaluate<string>('document.querySelector("[data-volume]").value'),'47')
      await evaluate('document.querySelector("[data-seek]").focus()');await key('Up');assert.equal(await evaluate<string>('document.querySelector("[data-volume]").value'),'47')
      await evaluate('document.activeElement.blur()');await key('Up',['control']);await key('Down',['shift']);assert.equal(await evaluate<string>('document.querySelector("[data-volume]").value'),'47')
      await set({volume:98});await key('Up');await key('Up');assert.equal(await evaluate<string>('document.querySelector("[data-volume]").value'),'100')
      await set({volume:2});await key('Down');await key('Down');assert.equal(await evaluate<string>('document.querySelector("[data-volume]").value'),'0')
      await set({volume:40})
      await evaluate('for(let i=0;i<12;i++)document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowUp",code:"ArrowUp",repeat:i>0,bubbles:true,cancelable:true}));void window.suMusic.setPreferences({theme:"night"})')
      await wait('document.querySelector("[data-volume]").value==="100"')
      await wait('window.suMusic.getState().then(result=>result.ok&&result.value.preferences.volume===100)')
      assert.equal(db.getPreferences().volume,100)
      assert.equal(await evaluate<string>('document.querySelector("[data-volume]").value'),'100')
      report.volumeArrowStepsBoundsFocusAndLatestSave=true
    }
    await set({volume:0});await evaluate('(()=>{const e=document.querySelector("[data-seek]");e.value="0";e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));})()');await evaluate('window.suMusic.playerCommand({type:"control",action:"resume"})');await delay(80)
    report.rangeFillEndpointsAndMidpointVerified=true
    if(functional){
      const browsingScroll=await evaluate<number>('document.querySelector(".content").scrollTop');await click('[data-now]')
      await wait('Boolean(document.querySelector("[data-lyric-active]"))&&Array.from(document.querySelectorAll(".player-cover img,.now-artwork img")).length===2&&Array.from(document.querySelectorAll(".player-cover img,.now-artwork img")).every(img=>img.complete&&img.naturalWidth>0)')
      assert(await evaluate<boolean>('document.querySelector(".player-cover img").src===document.querySelector(".now-artwork img").src'))
      const seekLyrics=async(position:number):Promise<void>=>{await evaluate('(()=>{const e=document.querySelector("[data-seek]");e.value='+position+';e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}))})()');await delay(200)}
      await seekLyrics(10000);await wait('document.querySelector("[data-lyric-active]")?.dataset.lyricTime==="9000"');await click('[data-play-toggle]');await wait('document.querySelector("[data-audio]").paused')
      const pausedLine=await evaluate<string>('document.querySelector("[data-lyric-active]").dataset.lyricIndex');await delay(300);assert.equal(await evaluate<string>('document.querySelector("[data-lyric-active]").dataset.lyricIndex'),pausedLine)
      const lyricPoint=await point('[data-lyrics-scroll]');window.webContents.sendInputEvent({type:'mouseMove',...lyricPoint});window.webContents.sendInputEvent({type:'mouseWheel',...lyricPoint,deltaX:0,deltaY:-200});await wait('Boolean(document.querySelector("[data-lyrics-follow]"))')
      await delay(400);await evaluate('document.querySelector("[data-lyrics-scroll]").scrollTop=0');await click('[data-play-toggle]');await delay(2400)
      assert.equal(await evaluate<number>('document.querySelector("[data-lyrics-scroll]").scrollTop'),0)
      const media=player.snapshot().media!.id;await click('[data-queue]');await layout('now-queue-manual-lyrics');assert(await evaluate<boolean>('Boolean(document.querySelector("[data-lyrics-follow]"))&&document.querySelector("[data-lyrics-scroll]").scrollTop===0'))
      await capture('now-queue-bilingual-lyrics');await click('[data-queue]');assert.equal(player.snapshot().media!.id,media)
      await nativeClick('[data-lyrics-follow]');await wait('(()=>{const c=document.querySelector("[data-lyrics-scroll]"),r=document.querySelector("[data-lyric-active]").getBoundingClientRect(),a=c.getBoundingClientRect();return !document.querySelector("[data-lyrics-follow]")&&Math.abs((r.top+r.bottom)/2-(a.top+c.clientHeight/2))<4})()')
      await seekLyrics(2000);await wait('document.querySelector("[data-lyric-active]")?.dataset.lyricTime==="0"');await layout('now-bilingual-seek-back');await capture('now-bilingual-cover')
      await click('[data-now-back]');assert.equal(await evaluate<number>('document.querySelector(".content").scrollTop'),browsingScroll)
      report.coverAndBilingualLyricsSeekPauseManualFollowAndQueue=true
    }
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
    await click('[data-nav="library"]');await click('.pinned-item');const exp1=await evaluate<boolean>('Boolean(document.querySelector("[data-inline-actions=\\"3\\"]"))');if(!exp1)await click('[data-track-position="3"]');await click('[data-edit-version]');await wait('Boolean(document.querySelector("[data-version-panel] [data-use-remember]"))')
    await layout('version-panel-1280');await capture('night-version-panel');await key('Escape')
    window.setSize(960,640);await delay(150)
    for(const theme of ['day','night'] as const){await set({theme});for(const page of ['library','search','history','review','local','settings','now']){await set({currentPage:page});await layout(theme+'-'+page+'-minimum')}await capture(theme+'-minimum')}
    await click('[data-queue]');await layout('queue-minimum');await key('Escape');await set({currentPage:'library'});const exp2=await evaluate<boolean>('Boolean(document.querySelector("[data-inline-actions=\\"3\\"]"))');if(!exp2)await click('[data-track-position="3"]');await click('[data-edit-version]');await delay(100);await layout('version-minimum');await capture('version-minimum');await key('Escape')
    if(functional){
    await key('k',['control']);await wait('Boolean(document.querySelector("[data-search-flyout]"))');report.searchShortcut=true;await key('Escape');await wait('!document.querySelector("[data-search-flyout]")')
    await click('[data-nav="library"]');await click('.pinned-item');await evaluate('document.querySelector("[data-track-position=\\"1\\"]").focus()');await key('Space');await wait('Boolean(document.querySelector("[data-inline-actions=\\"1\\"]"))');await key('Space');await wait('!document.querySelector("[data-inline-actions=\\"1\\"]")');report.spacePlaybackShortcut=true
    await key('Enter');await wait('document.querySelector("[data-audio]").currentTime>0.15&&!document.querySelector("[data-audio]").paused');assert.notEqual(player.snapshot().media!.id,token);const current=player.snapshot().queue.find(item=>item.id===player.snapshot().currentId)!;assert.equal(current.target.kind,'original');if(current.target.kind==='original')assert.equal(current.target.reference.position,1);report.enterSongRowPlays=true
    await key('Tab');assert.equal(await evaluate<boolean>('document.activeElement instanceof HTMLButtonElement||document.activeElement instanceof HTMLInputElement'),true);report.tabReachesInteractiveControls=true
    }
    await evaluate('window.suMusic.playerCommand({type:"control",action:"stop"})');await wait('document.querySelector("[data-audio]").paused')
    await set({currentPage:'settings'});await click('[data-notices]');await wait('document.querySelector("dialog").open');await layout('license-dialog-minimum');if(functional){const notices=await evaluate<string>('document.querySelector("dialog pre").textContent');assert(notices.includes('qrcode')&&notices.includes('electron'))}await key('Escape');await wait('!document.querySelector("dialog").open');report.licensesKeyboardDismissed=true
    await click('[data-nav="library"]');await click('[data-view="list"]');await input('[aria-label="筛选歌单名称"]','默认收藏');await click('[data-collections] .collection-card');await wait('document.querySelector(".empty-inline")?.textContent.includes("没有曲目")');await layout('empty-playlist-minimum');report.emptyCollectionHasClearState=true
    await set({theme:'night',density:'compact',libraryView:'list',currentPage:'settings',volume:0});report.requestCounts=requests.get(root);report.elapsedMs=Math.round(performance.now()-began);report.passed=true
  }catch(error){report.error=error instanceof Error?error.message:'P4_SMOKE_FAILED';report.state={phase:player.snapshot().phase,reason:player.snapshot().reason};try{report.ui=await evaluate('(()=>{const c=document.querySelector(".content"),b=document.querySelector("[data-scroll-top]"),a=document.activeElement,r=b?.getBoundingClientRect();return{top:c?.scrollTop,disabled:b?.disabled,active:a?.outerHTML?.slice(0,300),nav:getComputedStyle(document.querySelector("[data-playlist-navigation]")).pointerEvents,hit:r?document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2)?.outerHTML?.slice(0,300):null}})()');await capture('failure')}catch{}throw error}
  finally{report.elapsedMs=Math.round(performance.now()-began);report.requestCounts=requests.get(root);fs.writeFileSync(path.join(root,'report-'+phase+'.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({p4SmokePassed:report.passed,phase,scale,error:report.error??null,scenes:(report.scenes as unknown[]).length}))}
}
