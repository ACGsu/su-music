<script setup lang="ts">
import {nextTick,onBeforeUnmount,ref,watch} from 'vue'
import type {MediaEvent,PlayerState} from '../../shared/playback.ts'
const props=defineProps<{player:PlayerState|null;volume:number}>()
const audio=ref<HTMLAudioElement|null>(null)
let active:string|null=null,epoch=0,detach=()=>{},lastProgress=0,lastSeek=-1
function report(type:MediaEvent['type'],id:string,code?:number):void{
  const element=audio.value;if(!element||active!==id||props.player?.media?.id!==id)return
  const duration=Number.isFinite(element.duration)&&element.duration>0?Math.min(86400000,Math.round(element.duration*1000)):null
  void window.suMusic.reportMediaEvent({id,type,positionMs:Math.max(0,Math.min(86400000,Math.round((element.currentTime||0)*1000))),durationMs:duration,...(code!==undefined?{code}:{})})
}
function applySeek():void{
  const element=audio.value,player=props.player;if(!element||!player?.media||active!==player.media.id||element.readyState<1||lastSeek===player.seekSerial)return
  const target=Math.min(player.seekToMs/1000,Number.isFinite(element.duration)?element.duration:player.seekToMs/1000)
  lastSeek=player.seekSerial
  if(Math.abs(element.currentTime-target)>0.25)try{element.currentTime=target}catch{}
}
function applyPlaying():void{
  const element=audio.value,player=props.player,id=active,load=epoch
  if(!element||!id||!player?.media||player.media.id!==id)return
  if(!player.desiredPlaying){element.pause();return}
  if(!element.paused)return
  void element.play().catch(error=>{if(load!==epoch||active!==id||!props.player?.desiredPlaying||error?.name==='AbortError')return;report('error',id,error?.name==='NotAllowedError'?5:element.error?.code??4)})
}
watch(()=>props.player?.media?.id??null,async()=>{
  const load=++epoch;await nextTick();if(load!==epoch)return
  const element=audio.value;if(!element)return
  element.volume=Math.max(0,Math.min(1,props.volume/100))
  active=null;detach();element.pause();element.removeAttribute('src');element.load();lastSeek=-1;lastProgress=0
  const media=props.player?.media;if(!media)return
  active=media.id
  const listeners:{type:string;handler:EventListener}[]=[]
  const listen=(type:string,handler:()=>void)=>{const fn:EventListener=()=>{if(load===epoch&&active===media.id&&element.currentSrc===media.url)handler()};element.addEventListener(type,fn);listeners.push({type,handler:fn})}
  listen('loadedmetadata',()=>{report('metadata',media.id);applySeek();applyPlaying()})
  listen('playing',()=>report('playing',media.id))
  listen('pause',()=>report('paused',media.id))
  listen('waiting',()=>report('waiting',media.id))
  listen('seeking',()=>report('seeking',media.id))
  listen('timeupdate',()=>{if(performance.now()-lastProgress>=450){lastProgress=performance.now();report('progress',media.id)}})
  listen('ended',()=>{report('progress',media.id);report('ended',media.id)})
  listen('error',()=>report('error',media.id,element.error?.code??4))
  detach=()=>{for(const item of listeners)element.removeEventListener(item.type,item.handler)}
  element.src=media.url;element.load();applyPlaying()
},{immediate:true,flush:'post'})
watch(()=>props.player?.desiredPlaying,()=>applyPlaying(),{flush:'post'})
watch(()=>props.player?.seekSerial,()=>applySeek(),{flush:'post'})
watch(()=>props.volume,value=>{if(audio.value)audio.value.volume=Math.max(0,Math.min(1,value/100))},{immediate:true,flush:'post'})
onBeforeUnmount(()=>{epoch++;active=null;detach();audio.value?.pause()})
</script>
<template><audio ref="audio" data-audio preload="auto" aria-hidden="true" /></template>
