import { nativeImage } from 'electron'
import { createHash } from 'node:crypto'

export function metadataSmokeResponse(url: URL): Response | null {
  if (url.hostname === 'music.163.com' && url.pathname === '/api/song/detail/') {
    const id = url.searchParams.get('id')
    if (!id || !/^\d+$/.test(id)) return new Response('{}')
    return new Response(JSON.stringify({ code: 200, songs: [{ id: Number(id), al: { picUrl: 'https://imge.kugou.com/su-test/' + id + '.png' } }] }))
  }
  if (url.hostname === 'music.163.com' && url.pathname === '/api/song/lyric') {
    const id = url.searchParams.get('id')
    const lines = Array.from({ length: 60 }, (_, index) => {
      const seconds = index * 3, stamp = '[' + String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0') + '.000]'
      return { original: stamp + (index === 0 ? '歌曲 ' + id + ' の始まり' : '君と歩く道 · 第 ' + (index + 1) + ' 句'), translated: stamp + (index === 0 ? '歌曲 ' + id + ' 的开始' : '与你走过的路 · 第 ' + (index + 1) + ' 句') }
    })
    return new Response(JSON.stringify({ code: 200, lrc: { lyric: lines.map(line => line.original).join('\n') }, tlyric: { lyric: lines.map(line => line.translated).join('\n') } }))
  }
  if (url.hostname === 'm.kugou.com' && url.pathname === '/app/i/getSongInfo.php') {
    const hash = url.searchParams.get('hash')
    return new Response(JSON.stringify({ hash, album_img: 'https://imge.kugou.com/su-test/' + hash + '.png' }))
  }
  if (url.hostname === 'imge.kugou.com' && /^\/su-test\/[-\w]+\.png$/.test(url.pathname)) {
    const color = createHash('sha256').update(url.pathname).digest(), width = 128, bitmap = Buffer.alloc(width * width * 4)
    for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4, light = x > 24 && x < 104 && y > 24 && y < 104 ? 50 : 0
      bitmap[offset] = Math.min(255, color[0]! + light); bitmap[offset + 1] = Math.min(255, color[1]! + light); bitmap[offset + 2] = Math.min(255, color[2]! + light); bitmap[offset + 3] = 255
    }
    return new Response(new Uint8Array(nativeImage.createFromBitmap(bitmap, { width, height: width }).toPNG()), { headers: { 'Content-Type': 'image/png' } })
  }
  return null
}
