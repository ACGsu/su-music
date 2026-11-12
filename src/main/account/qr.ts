import { create } from '../../vendor/qrcode/core/qrcode.cjs'
export function qrImage(key:string):string{
  const text='https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode='+encodeURIComponent(key)
  const matrix=create([{data:text,mode:'byte'}],{errorCorrectionLevel:'M'}).modules,quiet=4,size=matrix.size+quiet*2
  const points:string[]=[]
  for(let row=0;row<matrix.size;row++)for(let col=0;col<matrix.size;col++)if(matrix.data[row*matrix.size+col])points.push(`M${col+quiet} ${row+quiet}h1v1h-1z`)
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="white"/><path d="${points.join('')}" fill="black"/></svg>`
  return 'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64')
}
