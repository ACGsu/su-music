import {app,dialog} from 'electron'
import type {BrowserWindow} from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {setTimeout as delay} from 'node:timers/promises'
import type {MusicDatabase} from './database.ts'
import type {PlayerController} from './player/controller.ts'
import type {SongCache} from './player/cache.ts'
import type {MediaRegistry} from './player/media.ts'
import {PublicHttpClient} from './music/http.ts'
import type {FetchFunction} from './music/http.ts'
import {byteRange} from './player/media.ts'
import {matchCandidates} from './music/matching.ts'
import type {SourceCandidate,ImportedPlaylist} from '../shared/music.ts'
import {candidateKey} from '../shared/music.ts'
import type {PlayerState} from '../shared/playback.ts'

const A:SourceCandidate={providerId:'gd',sourceId:'netease',trackId:'1001',title:'播放验证 (Original ver.)',artists:['验证音频'],album:'测试录音',aliases:[],durationMs:8000,metadataComplete:true}
const SAME:SourceCandidate={...A,trackId:'1005',durationMs:8350}
const B:SourceCandidate={...A,trackId:'1002',title:'播放验证 (Movie edit)',artists:['替代演唱者'],album:'替代版专辑',durationMs:6000}
const BAD:SourceCandidate={...A,trackId:'1003',title:'不可用验证曲目',durationMs:12000}
const WRONG:SourceCandidate={...A,trackId:'1004',title:'时长不符验证曲目',durationMs:14000}
const id=(candidate:SourceCandidate)=>({providerId:candidate.providerId,sourceId:candidate.sourceId,trackId:candidate.trackId})
export function generatedWav(ms:number):Buffer{
  const sampleRate=48000,frames=Math.round(sampleRate*ms/1000),bytes=frames*2,buffer=Buffer.alloc(bytes+44)
  buffer.write('RIFF',0);buffer.writeUInt32LE(bytes+36,4);buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(sampleRate,24);buffer.writeUInt32LE(sampleRate*2,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(bytes,40)
  for(let index=0;index<frames;index++)buffer.writeInt16LE(Math.round(Math.sin(index*440*2*Math.PI/sampleRate)*1200),44+index*2)
  return buffer
}
interface ApiObservations {urls:{id:string;quality:string}[];media:{id:string;method:string;range:string|null;status:number}[];expiredServed:boolean}
const observations=new Map<string,ApiObservations>()
export function p3MockHttp(root:string):PublicHttpClient{
  observations.set(root,{urls:[],media:[],expiredServed:false})
  fs.mkdirSync(path.join(root,'fixtures'),{recursive:true});if(!fs.existsSync(path.join(root,'fixtures','local.wav')))fs.writeFileSync(path.join(root,'fixtures','local.wav'),generatedWav(6000));fs.mkdirSync(path.join(root,'chosen-cache'),{recursive:true})
  const audio=p3MockAudio(root)
  return new PublicHttpClient(async(input,options)=>{
    const url=new URL(String(input)),stats=observations.get(root)!
    if(url.hostname==='music-api.gdstudio.xyz'){
      if(url.searchParams.get('types')==='url'){
        const trackId=url.searchParams.get('id')!,quality=url.searchParams.get('br')!;stats.urls.push({id:trackId,quality})
        return new Response(JSON.stringify(trackId==='1003'?{url:'',br:-1}:{url:'https://m8.music.126.net/'+trackId+'.wav',br:Number(quality)}))
      }
      throw new Error('P3_UNEXPECTED_SOURCE_REQUEST')
    }
    if(url.hostname==='m8.music.126.net')return audio(input,options)
    throw new Error('P3_UNEXPECTED_EXTERNAL_REQUEST')
  })
}
export function p3MockAudio(root:string):FetchFunction{
  return async(input,options)=>{
    const url=new URL(String(input)),trackId=/^\/(100[1-4])\.wav$/.exec(url.pathname)?.[1]
    if(url.hostname!=='m8.music.126.net'||!trackId)throw new Error('P3_UNEXPECTED_EXTERNAL_REQUEST')
    const stats=observations.get(root)!,headers=new Headers(options?.headers),range=headers.get('range'),method=options?.method??'GET'
    assert.equal(options?.credentials,'omit');assert(!headers.has('cookie')&&!headers.has('authorization'))
    if(trackId==='1001'&&!stats.expiredServed){stats.expiredServed=true;stats.media.push({id:trackId,method,range,status:403});return new Response(null,{status:403})}
    const data=generatedWav(trackId==='1001'?8000:6000),bounds=byteRange(range,data.length),body=bounds?data.subarray(bounds.start,bounds.end+1):data
    const responseHeaders:Record<string,string>={'Content-Type':'audio/wav','Content-Length':String(body.length),'Accept-Ranges':'bytes'}
    if(bounds)responseHeaders['Content-Range']=`bytes ${bounds.start}-${bounds.end}/${data.length}`
    stats.media.push({id:trackId,method,range,status:bounds?206:200})
    return new Response(method==='HEAD'?null:new Uint8Array(body),{status:bounds?206:200,headers:responseHeaders})
  }
}
export function seedP3Smoke(db:MusicDatabase,phase:string):void{
  if(phase==='first'){
    db.insertCollection({id:'p3-library',name:'P3 播放验证歌单',kind:'shared',provider:'kugou',accountKey:'local',sourceKey:'p3-library'})
    for(const [index,candidate]of [A,A,BAD].entries())db.insertTrack('p3-library',{position:index+1,title:candidate.title+'.mp3',filename:'验证音频 - '+candidate.title+'.mp3',artist:'验证音频',album:'测试录音',version:index===2?null:'Original',durationMs:candidate.durationMs,hash:'preserved-duplicate',raw:{songname:candidate.title+'.mp3',name:'验证音频 - '+candidate.title+'.mp3'}})
  }
  for(const candidate of [A,SAME,B,BAD,WRONG])db.setSourceCache('candidate',candidateKey(candidate),candidate,86400000)
  for(const [index,candidate]of [A,A,BAD].entries()){
    const reference={collectionId:'p3-library',position:index+1};db.saveMatch(reference,db.originalSignature(reference)!,matchCandidates(db.getOriginal(reference)!,index<2?[candidate,SAME,B]:[candidate]))
  }
}
export async function runP3Smoke(window:BrowserWindow,db:MusicDatabase,player:PlayerController,cache:SongCache,media:MediaRegistry,phase:string):Promise<void>{
  const root=path.dirname(app.getPath('userData')),report:Record<string,unknown>={at:new Date().toISOString(),phase,packaged:app.isPackaged,network:'mocked GD and audio responses; no external calls',actualDecoder:'Chromium HTMLAudioElement; generated WAV PCM16/48kHz',audioOutputMuted:true,nativeDialogSimulated:true,schemaVersion:db.schemaVersion()}
  const originalDialog=dialog.showOpenDialog
  dialog.showOpenDialog=(async(...args:unknown[])=>{const options=args.at(-1) as {properties?:string[]};return{canceled:false,filePaths:[options.properties?.includes('openDirectory')?path.join(root,'chosen-cache'):path.join(root,'fixtures','local.wav')]}}) as typeof dialog.showOpenDialog
  const evaluate=<T>(code:string):Promise<T>=>window.webContents.executeJavaScript(code,true) as Promise<T>
  const wait=async(check:()=>boolean,timeout=20000):Promise<void>=>{const until=Date.now()+timeout;while(Date.now()<until){if(check())return;await delay(40)}throw new Error('P3_DESKTOP_WAIT_TIMEOUT')}
  const waitUI=async(code:string):Promise<void>=>{const until=Date.now()+15000;while(Date.now()<until){if(await evaluate<boolean>(code))return;await delay(50)}throw new Error('P3_UI_WAIT_TIMEOUT')}
  const click=async(selector:string):Promise<void>=>{await evaluate('document.querySelector('+JSON.stringify(selector)+').click()');await delay(100)}
  const command=async(value:unknown):Promise<void>=>{assert.equal((await evaluate<{ok:boolean}>('window.suMusic.playerCommand('+JSON.stringify(value)+')')).ok,true);await delay(40)}
  const set=async(value:unknown):Promise<void>=>{assert.equal((await evaluate<{ok:boolean}>('window.suMusic.setPreferences('+JSON.stringify(value)+')')).ok,true);await delay(100)}
  const audio=():Promise<{time:number;duration:number;paused:boolean;volume:number;ready:number}>=>evaluate('(()=>{const a=document.querySelector("[data-audio]");return{time:a.currentTime,duration:a.duration,paused:a.paused,volume:a.volume,ready:a.readyState}})()')
  const capture=async(name:string):Promise<void>=>{
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await delay(250)
    for(let attempt=0;attempt<3;attempt++)try{const image=await window.webContents.capturePage();assert(!image.isEmpty());fs.writeFileSync(path.join(root,name+'.png'),image.toPNG());return}catch(error){if(attempt===2)throw error;await delay(500)}
  }
  const openVersion=async(position:number):Promise<void>=>{await set({currentPage:'library'});await click('[data-track-position="'+position+'"]');await click('[data-edit-version]');await delay(120)}
  const chooseThroughPanel=async(persistence:'once'|'remember'):Promise<void>=>{
    await openVersion(1)
    await click('[data-candidate-id="gd:netease:1002"] .button')
    await click(persistence==='once'?'[data-use-once]':'[data-use-remember]');await delay(150)
    const warning=await evaluate<string>('document.querySelector("[data-version-panel] .inline-warning")?.textContent??""')
    if(warning)throw new Error('P3_VERSION_BUTTON_FAILED: '+warning)
    await wait(()=>player.snapshot().phase==='playing')
  }
  try{
    await wait(()=>Boolean(window.webContents.mainFrame));await set({currentPage:'settings',volume:0,theme:'day'})
    assert.equal(await evaluate<boolean>('typeof window.require!=="undefined"||typeof window.process!=="undefined"'),false)
    assert.equal((await evaluate<{ok:boolean}>('window.suMusic.playerCommand({type:"play",target:{kind:"file",filename:"C:/private"}})')).ok,false)
    assert.equal((await evaluate<{ok:boolean}>('window.suMusic.chooseCacheDirectory("C:/arbitrary")')).ok,true)
    // A JavaScript caller cannot pass a path: the preload forwards no such argument.
    report.noRendererPathsAccepted=true
    if(phase==='resume'){
      assert.equal(cache.snapshot().usingDefault,false);assert.equal(db.getBinding({collectionId:'p3-library',position:1})!.slot,'alternative');assert.equal(player.snapshot().mode,'shuffle');assert(db.getHistory().some(item=>item.now.binding==='alternative'))
      await set({currentPage:'library'});await click('[data-shared-item]');await waitUI('Boolean(document.querySelector("[data-row-play=\\"1\\"]"))');assert.equal(db.getCollection('p3-library')!.tracks[0]!.title,B.title);report.selectedDisplayAndActionsRestored=true
      assert.equal(player.snapshot().phase,'idle');report.bindingModeCacheAndHistoryRestored=true
      await command({type:'play',target:{kind:'original',reference:{collectionId:'p3-library',position:1}}});await wait(()=>player.snapshot().phase==='playing');assert.equal(player.snapshot().now!.candidate!.trackId,'1002');assert.equal(player.snapshot().now!.binding,'alternative');report.rememberedActualVersionDecoded=true
      await command({type:'control',action:'pause'});await capture('resume-alternative');report.passed=true;return
    }
    await click('[data-cache-choose]');assert.equal(cache.snapshot().directory,path.join(root,'chosen-cache','Su Music Cache'));await evaluate('document.querySelector(".cache-settings").scrollIntoView({block:"start"})');await capture('day-cache-settings');report.selectedCacheDirectoryViaBridge=true
    await set({currentPage:'library'});await click('[data-shared-item]')
    assert.equal(await evaluate<boolean>('Array.from(document.querySelectorAll(".track-name")).every(element=>!element.textContent.includes(".mp3"))'),true);report.importedSuffixNotDisplayed=true
    assert.equal(await evaluate<boolean>('Boolean(document.querySelector("[data-row-play=\\"1\\"]"))&&Boolean(document.querySelector("[data-row-next=\\"1\\"]"))&&!document.querySelector("[data-track-position=\\"1\\"] [data-match-position]")'),true);report.matchedRowsHavePlaybackActions=true
    await click('[data-play-collection]');await wait(()=>player.snapshot().phase==='playing')
    assert.equal(await evaluate<boolean>('Boolean(document.querySelector("[data-version-panel]"))'),false);assert.equal(player.snapshot().now!.binding,'same');assert.equal(player.snapshot().reason,null);report.sameVersionPlayedWithoutSelection=true
    assert.equal(player.snapshot().queue.length,3);assert.notEqual(player.snapshot().queue[0]!.id,player.snapshot().queue[1]!.id);assert.equal(player.snapshot().now!.verifiedBitrateKbps,768)
    const stats=observations.get(root)!;assert.deepEqual(stats.urls.filter(item=>item.id==='1001').map(item=>item.quality),['320','128']);report.expiredAddressRecoveredWithinTwoAttempts=true
    assert.equal((await audio()).volume,0);await delay(750);const before=await audio(),mediaId=player.snapshot().media!.id,queueIds=player.snapshot().queue.map(item=>item.id)
    await evaluate('window.__p3AudioNode=document.querySelector("[data-audio]")')
    for(const target of ['settings','search','history','review','local','now','library']){await set({currentPage:target,theme:target==='history'?'night':'day'});assert.equal(await evaluate<boolean>('window.__p3AudioNode===document.querySelector("[data-audio]")'),true);assert.equal(player.snapshot().media!.id,mediaId);assert.deepEqual(player.snapshot().queue.map(item=>item.id),queueIds)}
    await click('[data-track-position="2"]');const keyAllowed=await evaluate<boolean>('(()=>{const b=document.querySelector("[data-edit-version]");return b.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))})()');assert.equal(keyAllowed,true)
    await click('[data-edit-version]');assert.equal(player.snapshot().media!.id,mediaId);assert.deepEqual(player.snapshot().queue.map(item=>item.id),queueIds);await click('[data-version-panel] [aria-label="关闭版本对照"]');report.versionKeyboardKeepsPlayback=true
    await click('[data-queue]');await click('[data-queue]');const after=await audio();assert(after.time>before.time);assert.equal(after.paused,false);report.actualAudioContinuousAcrossNavigationThemeAndPanel=true
    await command({type:'control',action:'pause'});const paused=(await audio()).time;await delay(300);assert(Math.abs((await audio()).time-paused)<0.08);report.pauseKeepsPosition=true
    await command({type:'seek',positionMs:4200});await delay(120);assert(Math.abs((await audio()).time-4.2)<0.3);report.actualSeekVerified=true
    await command({type:'control',action:'previous'});assert((await audio()).time<0.3);await command({type:'control',action:'resume'});await wait(()=>player.snapshot().phase==='playing')
    const firstId=player.snapshot().currentId;await wait(()=>player.snapshot().currentId!==firstId,12000);assert.equal(player.snapshot().queue.find(item=>item.id===player.snapshot().currentId)!.target.kind,'original');await wait(()=>player.snapshot().phase==='playing');report.naturalEndedAdvancesQueue=true
    assert(db.getHistory().some(item=>item.completed));assert(cache.snapshot().tracks>0);report.completeDownloadCacheCreated=true
    await command({type:'control',action:'pause'});const priorHistory=db.getHistory().length;await command({type:'play',target:{kind:'candidate',candidate:id(WRONG)}});await wait(()=>player.snapshot().phase==='needs_review');assert.equal(db.getHistory().length,priorHistory);report.actualDurationMismatchStopsBeforeHistory=true
    await chooseThroughPanel('once');assert.equal(db.getBinding({collectionId:'p3-library',position:1})!.slot,'original');assert.equal(player.snapshot().now!.binding,'alternative');report.onceDoesNotPersist=true;report.versionPanelOnceButtonDecodedAudio=true
    await command({type:'control',action:'pause'});await set({currentPage:'now',theme:'night'});await capture('night-now-alternative')
    await chooseThroughPanel('remember');await command({type:'control',action:'pause'});report.versionPanelRememberButtonDecodedAudio=true
    await waitUI('document.querySelector("[data-track-position=\\"1\\"] .track-name")?.textContent.includes("Movie edit")')
    const selectedRow=db.getCollection('p3-library')!.tracks[0]!;assert.equal(selectedRow.title,B.title);assert.equal(selectedRow.artist,B.artists.join('、'));assert.equal(selectedRow.album,B.album);assert.equal(selectedRow.durationMs,B.durationMs)
    assert.equal(await evaluate<boolean>('!document.querySelector("[data-track-position=\\"1\\"] .state-cell [data-match-position]")&&Boolean(document.querySelector("[data-row-next=\\"1\\"]"))'),true);report.selectedVersionMetadataReplacesRow=true;await capture('selected-version-row')
    await click('[data-row-next="1"]');const enqueued=player.snapshot().queue[1]!;assert.equal(enqueued.title,B.title);assert.equal(enqueued.target.kind,'original');assert.equal(player.snapshot().phase,'paused');report.rowNextEnqueuesSelectedVersion=true
    await click('[data-row-play="1"]');await wait(()=>player.snapshot().phase==='playing');assert.equal(player.snapshot().now!.candidate!.trackId,'1002');report.rowPlayUsesSelectedVersion=true
    const playingMedia=player.snapshot().media!.id
    const synced:ImportedPlaylist={sourceKey:'p3-library',name:'P3 播放验证歌单',originalUrl:'https://t1.kugou.com/test',observedAt:new Date().toISOString(),tracks:db.getCollection('p3-library')!.tracks.map(track=>({...db.getOriginal({collectionId:'p3-library',position:track.position})!,raw:{cloud:'updated'}}))}
    synced.tracks[0]={...synced.tracks[0]!,hash:'new-returned-hash',album:'同步更新的原专辑',durationMs:8100}
    assert.equal(db.replaceSharedPlaylist(synced).collection.id,'p3-library');await waitUI('document.querySelector("[data-track-position=\\"1\\"] .track-name")?.textContent.includes("Movie edit")')
    assert.equal(db.getCollection('p3-library')!.tracks[0]!.title,B.title);assert.equal(db.getCollection('p3-library')!.tracks[0]!.durationMs,6000);assert.equal(player.snapshot().media!.id,playingMedia);assert.equal(player.snapshot().phase,'playing');report.selectedDisplaySurvivesSyncDuringPlayback=true
    await command({type:'control',action:'pause'})
    assert.equal(db.getOriginal({collectionId:'p3-library',position:1})!.durationMs,synced.tracks[0]!.durationMs);assert.equal(db.getBinding({collectionId:'p3-library',position:1})!.slot,'alternative');report.rememberedAlternativeKeepsOriginal=true
    const alternative=db.getHistory().find(item=>item.now.binding==='alternative')!;assert(alternative);await evaluate('window.suMusic.playHistory('+JSON.stringify(alternative.id)+')');await wait(()=>player.snapshot().phase==='playing');assert.equal(player.snapshot().now!.candidate!.trackId,'1002');await command({type:'control',action:'pause'});report.historyReplaysActualAlternative=true
    await set({currentPage:'local'});await click('[data-local-import]');assert.equal(db.getLocalTracks().length,1);await click('[data-local-item] .button');await wait(()=>player.snapshot().phase==='playing');assert.equal(player.snapshot().now!.source,'本地文件');assert.equal(player.snapshot().now!.format,'WAV');report.localFileDecodedViaNativeSelectionBridge=true
    await command({type:'control',action:'pause'});await command({type:'enqueue',target:{kind:'candidate',candidate:id(B)},placement:'next'});await click('[data-queue]');await capture('queue-controls');await click('[data-queue]')
    const local=db.getLocalTracks()[0]!;await openVersion(1)
    await evaluate('(()=>{const select=document.querySelector("[aria-label=\\"选择已有本地音乐\\"]");select.value='+JSON.stringify(local.id)+';select.dispatchEvent(new Event("change",{bubbles:true}))})()')
    await click('.local-association .button');await wait(()=>player.snapshot().phase==='playing');assert.equal(player.snapshot().now!.binding,'local');report.versionPanelLocalAssociationButtonDecodedAudio=true;await command({type:'control',action:'pause'})
    await openVersion(1);await click('[data-restore-original]');await wait(()=>player.snapshot().phase==='playing');assert.equal(player.snapshot().now!.candidate!.trackId,'1001');assert.equal(player.snapshot().now!.fromCache,true);report.originalRestoredFromCompleteCache=true;report.versionPanelRestoreButtonDecodedAudio=true
    await command({type:'control',action:'stop'});await command({type:'mode',mode:'shuffle'});await command({type:'choose',reference:{collectionId:'p3-library',position:1},candidate:id(B),persistence:'remember'});await wait(()=>player.snapshot().phase==='playing');await command({type:'control',action:'pause'})
    await set({currentPage:'history',theme:'night'});await capture('night-history');assert(db.getHistory().every(item=>item.now.candidate||item.now.localId));report.actualVersionHistoryRecorded=true
    await set({currentPage:'settings'});await evaluate('document.querySelector(".cache-settings").scrollIntoView({block:"start"})');await capture('night-cache-summary');report.mediaObservations=media.observations;report.apiObservations=stats;report.finalState=player.snapshot();report.cache=cache.snapshot();report.passed=true
  }catch(error){report.passed=false;report.error=error instanceof Error?error.message:'P3_RUNTIME_FAILED';report.state=player.snapshot();report.apiObservations=observations.get(root);throw error}
  finally{dialog.showOpenDialog=originalDialog;fs.writeFileSync(path.join(root,'report-'+phase+'.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({p3SmokePassed:report.passed,phase,error:report.error??null}))}
}
