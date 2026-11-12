import fs from 'node:fs'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {inspectAudioHeader} from '../music/audio.ts'
import type {MusicDatabase} from '../database.ts'
import type {LocalTrack} from '../../shared/playback.ts'
export function registerLocalFile(db:MusicDatabase,selectedFilename:string):LocalTrack{
  const filename=fs.realpathSync(selectedFilename),stat=fs.statSync(filename),extension=path.extname(filename).toLowerCase()
  if(!stat.isFile()||stat.size<16||stat.size>8*1024*1024*1024||!['.mp3','.flac','.wav'].includes(extension))throw new Error('LOCAL_AUDIO_INVALID')
  const fd=fs.openSync(filename,'r');let data=Buffer.alloc(Math.min(stat.size,65536))
  try{
    fs.readSync(fd,data,0,data.length,0)
    if(extension==='.mp3'&&data.subarray(0,3).toString()==='ID3'&&data.length>=10&&[6,7,8,9].every(index=>(data[index]!&0x80)===0)){
      const offset=10+((data[6]!<<21)|(data[7]!<<14)|(data[8]!<<7)|data[9]!)+(data[5]!&0x10?10:0)
      if(offset>=data.length&&offset<stat.size){data=Buffer.alloc(Math.min(65536,stat.size-offset));fs.readSync(fd,data,0,data.length,offset)}
    }
  }finally{fs.closeSync(fd)}
  let format:string|null=null,durationMs:number|null=null,bitrateKbps:number|null=null
  if(extension==='.wav'&&data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WAVE'){
    format='WAV';let rate=0,bytesPerSecond=0
    for(let offset=12;offset+8<=data.length;){const name=data.subarray(offset,offset+4).toString(),size=data.readUInt32LE(offset+4)
      if(name==='fmt '&&size>=16&&offset+24<=data.length){rate=data.readUInt32LE(offset+12);bytesPerSecond=data.readUInt32LE(offset+16);bitrateKbps=bytesPerSecond*8/1000}
      if(name==='data'&&bytesPerSecond&&rate){durationMs=Math.round(Math.min(size,stat.size-offset-8)*1000/bytesPerSecond);break}offset+=8+size+(size%2)
    }
  }else{const audio=inspectAudioHeader(data);format=audio.format;bitrateKbps=audio.bitrateKbps
    if(format==='FLAC'&&audio.sampleRateHz&&data.length>=26){const samples=(BigInt(data[21]!&15)<<32n)|BigInt(data.readUInt32BE(22));if(samples>0n)durationMs=Math.round(Number(samples)*1000/audio.sampleRateHz)}
  }
  if(!format||extension==='.wav'&&!durationMs)throw new Error('LOCAL_AUDIO_INVALID')
  return db.registerLocal({id:randomUUID(),filename,name:path.basename(filename,path.extname(filename)),format,durationMs,bitrateKbps,missing:false,size:stat.size,mtime:stat.mtimeMs,addedAt:new Date().toISOString()})
}
