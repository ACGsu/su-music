export interface AudioHeader { format: string | null; bitrateKbps: number | null; sampleRateHz: number | null }
export function inspectAudioHeader(bytes: Uint8Array): AudioHeader {
  const data = Buffer.from(bytes), empty = { format: null, bitrateKbps: null, sampleRateHz: null }
  if(data.length>=36&&data.subarray(0,4).toString('ascii')==='RIFF'&&data.subarray(8,12).toString('ascii')==='WAVE'){
    for(let offset=12;offset+24<=data.length;){const size=data.readUInt32LE(offset+4)
      if(data.subarray(offset,offset+4).toString('ascii')==='fmt '&&size>=16){const rate=data.readUInt32LE(offset+12),byteRate=data.readUInt32LE(offset+16);if(rate>0&&byteRate>0)return{format:'WAV',bitrateKbps:byteRate*8/1000,sampleRateHz:rate};break}
      offset+=8+size+(size%2)
    }return empty
  }
  if (data.subarray(0, 4).toString('ascii') === 'fLaC') {
    if (data.length < 42 || (data[4]! & 0x7f) !== 0 || data.readUIntBE(5, 3) !== 34) return empty
    const rate = data.length >= 22 ? ((data[18]! << 12) | (data[19]! << 4) | (data[20]! >> 4)) : null
    return rate && rate <= 655350 ? { format: 'FLAC', bitrateKbps: null, sampleRateHz: rate } : empty
  }
  let start = 0
  if (data.subarray(0, 3).toString('ascii') === 'ID3' && data.length >= 10) {
    if ([6,7,8,9].some(index => (data[index]! & 0x80) !== 0)) return empty
    start = 10 + ((data[6]! << 21) | (data[7]! << 14) | (data[8]! << 7) | data[9]!)
    if (data[5]! & 0x10) start += 10
  }
  const parse = (offset: number): { bitrate: number; sample: number; frameSize: number } | null => {
    if (offset + 4 > data.length || data[offset] !== 0xff || (data[offset + 1]! & 0xe0) !== 0xe0) return null
    const version = (data[offset + 1]! >> 3) & 3, layer = (data[offset + 1]! >> 1) & 3
    const index = data[offset + 2]! >> 4, rateIndex = (data[offset + 2]! >> 2) & 3
    if (version === 1 || layer !== 1 || index === 0 || index === 15 || rateIndex === 3) return null
    const bitrates = version === 3 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320] : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160]
    const bitrate = bitrates[index]!, sample = [44100,48000,32000][rateIndex]! / (version === 3 ? 1 : version === 2 ? 2 : 4)
    return { bitrate, sample, frameSize: Math.floor((version === 3 ? 144000 : 72000) * bitrate / sample) + ((data[offset + 2]! >> 1) & 1) }
  }
  for (let offset = start; offset < Math.min(data.length - 4, start + 4096); offset++) {
    const first = parse(offset)
    if (!first) continue
    const second = parse(offset + first.frameSize)
    if (second && second.sample === first.sample) return { format: 'MP3', bitrateKbps: second.bitrate === first.bitrate ? first.bitrate : null, sampleRateHz: first.sample }
  }
  return empty
}
