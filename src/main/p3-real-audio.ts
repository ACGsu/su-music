import {app} from 'electron'
import type {BrowserWindow} from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {setTimeout as delay} from 'node:timers/promises'
import type {MusicDatabase} from './database.ts'
import type {PlayerController} from './player/controller.ts'
import type {SongCache} from './player/cache.ts'
import type {MediaRegistry} from './player/media.ts'
import type {FetchFunction} from './music/http.ts'
import type {SourceCandidate} from '../shared/music.ts'
import {candidateKey} from '../shared/music.ts'

const CONTROL:SourceCandidate={providerId:'gd',sourceId:'netease',trackId:'33190124',title:'Carefree',artists:['Kevin MacLeod'],album:null,aliases:[],durationMs:205078,metadataComplete:true}
const observations={urlRequests:0,audioRequests:0}
export function realAudioFetch():FetchFunction{
  return async(input,options)=>{
    const url=new URL(String(input)),headers=new Headers(options?.headers)
    assert.equal(options?.credentials,'omit');assert(!headers.has('authorization')&&!headers.has('cookie'))
    if(url.hostname==='music-api.gdstudio.xyz'){
      if(url.searchParams.get('types')!=='url'||url.searchParams.get('id')!==CONTROL.trackId)throw new Error('REAL_CONTROL_REQUEST_NOT_ALLOWED')
      observations.urlRequests++;if(observations.urlRequests>2)throw new Error('REAL_CONTROL_ATTEMPT_LIMIT')
    }else{
      if(!['music.126.net','music.163.com','music126.net'].some(host=>url.hostname===host||url.hostname.endsWith('.'+host)))throw new Error('REAL_CONTROL_HOST_NOT_ALLOWED')
      observations.audioRequests++
    }
    return fetch(input,options)
  }
}
export function seedRealControl(db:MusicDatabase):void{db.setSourceCache('candidate',candidateKey(CONTROL),CONTROL,86400000)}
export async function runRealAudio(window:BrowserWindow,db:MusicDatabase,player:PlayerController,cache:SongCache,media:MediaRegistry):Promise<void>{
  const root=path.dirname(app.getPath('userData')),started=Date.now(),report:Record<string,unknown>={startedAt:new Date(started).toISOString(),packaged:app.isPackaged,
    control:{artist:'Kevin MacLeod',title:'Carefree',gdSource:'netease',trackId:CONTROL.trackId,priorMetadataDurationMs:CONTROL.durationMs},
    audioOutputMuted:true,sharedGdBudget:true,realAccountUsed:false,fullPlaybackClaimed:false,passed:false}
  const evaluate=<T>(code:string):Promise<T>=>window.webContents.executeJavaScript(code,true) as Promise<T>
  const record=()=>{const state=player.snapshot();fs.writeFileSync(path.join(root,'state.json'),JSON.stringify({at:new Date().toISOString(),phase:state.phase,positionMs:state.positionMs,durationMs:state.durationMs,reason:state.reason,retryAt:state.retryAt,requests:observations},null,2)+'\n')}
  try{
    assert.equal((await evaluate<{ok:boolean}>('window.suMusic.setPreferences({volume:0,currentPage:"now",theme:"night"})')).ok,true)
    await evaluate('(()=>{const a=document.querySelector("[data-audio]");window.__p3RealAudio={element:a,events:[],ended:0};for(const type of ["loadedmetadata","playing","pause","waiting","seeking","ended","error"]){a.addEventListener(type,()=>{window.__p3RealAudio.events.push({type,time:a.currentTime,duration:Number.isFinite(a.duration)?a.duration:null,at:Date.now()});if(type==="ended")window.__p3RealAudio.ended++})}})()')
    player.command({type:'play',target:{kind:'candidate',candidate:{providerId:'gd',sourceId:'netease',trackId:CONTROL.trackId}}})
    const waitingEnd=Date.now()+330000
    while(player.snapshot().phase!=='playing'){
      record();if(['error','needs_review','ended'].includes(player.snapshot().phase))throw new Error('REAL_AUDIO_START_FAILED');if(Date.now()>waitingEnd)throw new Error('REAL_AUDIO_START_TIMEOUT');await delay(500)
    }
    const began=Date.now(),token=player.snapshot().media!.id,queue=player.snapshot().queue.map(item=>item.id)
    const initial=await evaluate<{time:number;duration:number;volume:number}>('(()=>{const a=document.querySelector("[data-audio]");return{time:a.currentTime,duration:a.duration,volume:a.volume}})()')
    assert.equal(initial.volume,0);assert(initial.time<1);report.decodedDurationMs=Math.round(initial.duration*1000)
    let lastLogged=0,switched=false,maximumPosition=0
    while(player.snapshot().phase!=='ended'){
      const state=player.snapshot();record()
      if(['error','needs_review'].includes(state.phase))throw new Error('REAL_AUDIO_INTERRUPTED')
      if(Date.now()-began>initial.duration*1000+30000)throw new Error('REAL_AUDIO_END_TIMEOUT')
      const audio=await evaluate<{same:boolean;time:number;rate:number}>('(()=>{const a=document.querySelector("[data-audio]");return{same:window.__p3RealAudio.element===a,time:a.currentTime,rate:a.playbackRate}})()')
      assert(audio.same);assert.equal(audio.rate,1);maximumPosition=Math.max(maximumPosition,audio.time)
      if(state.media)assert.equal(state.media.id,token);assert.deepEqual(state.queue.map(item=>item.id),queue)
      if(!switched&&audio.time>12){
        for(const currentPage of ['library','search','history','now']){await evaluate('window.suMusic.setPreferences('+JSON.stringify({currentPage,theme:currentPage==='history'?'day':'night'})+')');await delay(200)}
        switched=true;fs.writeFileSync(path.join(root,'real-now-playing.png'),(await window.webContents.capturePage()).toPNG())
      }
      if(Date.now()-lastLogged>15000){lastLogged=Date.now();console.log(JSON.stringify({realAudioPhase:state.phase,positionSeconds:Math.floor(audio.time),durationSeconds:Math.round(initial.duration),requests:observations.urlRequests}))}
      await delay(500)
    }
    record();const events=await evaluate<{events:{type:string;time:number;duration:number|null;at:number}[];ended:number}>('window.__p3RealAudio'),history=db.getHistory().find(entry=>entry.now.candidate?.trackId===CONTROL.trackId)
    assert.equal(events.ended,1);assert(history?.completed);assert(Date.now()-began>=initial.duration*1000*0.95);assert(maximumPosition>=initial.duration-1)
    report.startedPlayingAt=new Date(began).toISOString();report.elapsedPlaybackMs=Date.now()-began;report.naturalEnded=true;report.navigationKeptAudioAndQueue=switched;report.history=history;report.events=events.events;report.requests={...observations};report.fullPlaybackClaimed=true
    assert(cache.snapshot().tracks>=1);assert.equal(player.snapshot().now!.format,'MP3');report.passed=true
  }catch(error){report.error=error instanceof Error?error.message:'REAL_AUDIO_FAILED';report.state=player.snapshot();report.requests={...observations};throw error}
  finally{report.cache=cache.snapshot();report.mediaObservations=media.observations;report.completedAt=new Date().toISOString();fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({realAudioPassed:report.passed,fullPlaybackClaimed:report.fullPlaybackClaimed,error:report.error??null}))}
}
