import { constants, createHash, publicEncrypt, randomBytes, randomUUID } from 'node:crypto'
import type { AccountInfo, Device, KugouSession } from '../../shared/account.ts'

const APPID=1005, SRCAPPID=2919, CLIENTVER=20489
const PUBLIC_KEY='-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDIAG7QOELSYoIJvTFJhMpe1s/gbjDJX51HBNnEl5HXqTW6lQ7LC8jr9fWZTwusknp+sVGzwd40MwP6U5yDE27M/X1+UR4tvOGOqp94TJtQ1EPnWGWXngpeIW5GxoQGao1rmYWAu6oi1z9XkChrsUdC6DJE5E221wf/4WLFxwAtRQIDAQAB\n-----END PUBLIC KEY-----'
export type KugouOperation='qr_key'|'qr_check'|'identity'|'directory'|'tracks'
export interface KugouRequest {url:string;method:'GET'|'POST';body?:string;headers:Record<string,string>}
export interface KugouTransport {call(operation:KugouOperation,session:KugouSession|Device,params?:Record<string,string|number>,signal?:AbortSignal):Promise<Record<string,unknown>>}
export class AccountError extends Error {code:string;constructor(code:string){super(code);this.code=code}}
const md5=(value:string)=>createHash('md5').update(value).digest('hex')
export function newKugouDevice():Device{const guid=md5(randomUUID());return{guid,mid:BigInt('0x'+md5(guid)).toString(),dev:randomBytes(5).toString('hex').toUpperCase(),dfid:'-'}}
export function record(value:unknown):Record<string,unknown>|null{return typeof value==='object'&&value!==null&&!Array.isArray(value)?value as Record<string,unknown>:null}
export function sessionValid(value:unknown):value is KugouSession{
  const s=record(value),d=record(s?.device)
  return !!s&&s.schema===1&&s.platform==='standard'&&typeof s.userid==='string'&&/^[1-9]\d{0,15}$/.test(s.userid)&&Number.isSafeInteger(Number(s.userid))&&typeof s.token==='string'&&s.token.length>0&&s.token.length<512&&
    !!d&&typeof d.guid==='string'&&/^[a-f0-9]{32}$/.test(d.guid)&&typeof d.mid==='string'&&/^\d{1,45}$/.test(d.mid)&&typeof d.dev==='string'&&/^[A-F0-9]{10}$/.test(d.dev)&&typeof d.dfid==='string'
}
export function buildKugouRequest(operation:KugouOperation,context:KugouSession|Device,input:Record<string,string|number>={},time=Math.floor(Date.now()/1000)):KugouRequest{
  const session='device'in context?context:null,device=session?session.device:context as Device
  const params:Record<string,string|number>={dfid:device.dfid||'-',mid:device.mid,uuid:'-',appid:APPID,clientver:CLIENTVER,clienttime:time}
  if(session){params.token=session.token;params.userid=session.userid}
  let pathname='',body='',host='gateway.kugou.com',method:'GET'|'POST'='POST',router='',web=false
  switch(operation){
    case 'qr_key':host='login-user.kugou.com';pathname='/v2/qrcode';method='GET';web=true;Object.assign(params,{appid:1001,type:1,plat:4,qrcode_txt:`https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=${APPID}&`,srcappid:SRCAPPID});break
    case 'qr_check':host='login-user.kugou.com';pathname='/v2/get_userinfo_qrcode';method='GET';web=true;if(typeof input.key!=='string'||!input.key||input.key.length>512)throw new AccountError('QR_RESPONSE_INVALID');Object.assign(params,{plat:4,appid:APPID,srcappid:SRCAPPID,qrcode:input.key,dev:device.dev});break
    case 'identity':{
      if(!session)throw new AccountError('ACCOUNT_REQUIRED');pathname='/v3/get_my_info';params.plat=1;router='usercenter.kugou.com'
      // The pinned client protocol uses raw RSA with JSON bytes right-padded to 128 bytes.
      const data=Buffer.from(JSON.stringify({token:session.token,clienttime:time}));if(data.length>128)throw new AccountError('CREDENTIAL_FORMAT_INVALID')
      const padded=Buffer.alloc(128);data.copy(padded)
      const p=publicEncrypt({key:PUBLIC_KEY,padding:constants.RSA_NO_PADDING},padded).toString('hex').toUpperCase()
      body=JSON.stringify({visit_time:time,usertype:1,p,userid:Number(session.userid)});break
    }
    case 'directory':if(!session)throw new AccountError('ACCOUNT_REQUIRED');pathname='/v7/get_all_list';router='cloudlist.service.kugou.com';Object.assign(params,{plat:1,userid:Number(session.userid),token:session.token});body=JSON.stringify({userid:session.userid,token:session.token,total_ver:979,type:2,page:input.page??1,pagesize:input.pagesize??100});break
    case 'tracks':if(!session)throw new AccountError('ACCOUNT_REQUIRED');pathname='/v4/get_list_all_file_v3';router='cloudlist.service.kugou.com';if(!['string','number'].includes(typeof input.listid))throw new AccountError('INVALID_REQUEST');body=JSON.stringify({listid:input.listid,userid:session.userid,type:Number(input.type??0),page:Number(input.page??1),pagesize:Number(input.pagesize??100),area_code:1,allplatform:1,show_cover:1,token:session.token});break
    default:throw new AccountError('ACCOUNT_ENDPOINT_DENIED')
  }
  const salt=web?'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt':'OIlwieks28dk2k092lksi2UIkp'
  const sorted=web?Object.keys(params).map(key=>`${key}=${params[key]}`).sort().join(''):Object.keys(params).sort().map(key=>`${key}=${params[key]}`).join('')
  params.signature=md5(salt+sorted+body+salt)
  const query=new URLSearchParams(Object.entries(params).map(([key,value])=>[key,String(value)]))
  const headers:Record<string,string>={'User-Agent':'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',dfid:device.dfid||'-',mid:device.mid,clienttime:String(time),'kg-rc':'1','kg-thash':'5d816a0','kg-rec':'1','kg-rf':'B9EDA08A64250DEFFBCADDEE00F8F25F'}
  if(router)headers['x-router']=router;if(method==='POST')headers['Content-Type']='application/json'
  return{url:`https://${host}${pathname}?${query}`,method,...(body?{body}:{}),headers}
}
export class KugouHttpTransport implements KugouTransport{
  private fetcher:typeof fetch;private tail:Promise<void>=Promise.resolve();private lastAt=0
  readonly requests:{at:string;operation:KugouOperation}[]=[]
  constructor(fetcher:typeof fetch=fetch){this.fetcher=fetcher}
  call(operation:KugouOperation,session:KugouSession|Device,params:Record<string,string|number>={},signal?:AbortSignal):Promise<Record<string,unknown>>{
    const work=this.tail.then(async()=>{
      if(signal?.aborted)throw new AccountError('ACCOUNT_CANCELLED')
      const wait=Math.max(0,650-(Date.now()-this.lastAt));if(wait)await new Promise<void>(resolve=>setTimeout(resolve,wait))
      if(signal?.aborted)throw new AccountError('ACCOUNT_CANCELLED')
      const timer=AbortSignal.timeout(15000),combined=signal?AbortSignal.any([signal,timer]):timer,request=buildKugouRequest(operation,session,params)
      this.lastAt=Date.now();this.requests.push({at:new Date().toISOString(),operation});if(this.requests.length>1000)this.requests.splice(0,500)
      try{
        const response=await this.fetcher(request.url,{method:request.method,body:request.body,headers:request.headers,signal:combined,credentials:'omit',redirect:'manual'})
        if(response.headers.get('ssa-code')){await response.body?.cancel();throw new AccountError('ADDITIONAL_VERIFICATION_REQUIRED')}
        if(!response.ok){await response.body?.cancel();throw new AccountError('ACCOUNT_NETWORK_ERROR')}
        const cookies=response.headers.getSetCookie?.()??[]
        const device='device' in session?session.device:session
        for(const cookie of cookies){const first=cookie.split(';')[0]??'',index=first.indexOf('=');if(index<1)continue;const key=first.slice(0,index),value=first.slice(index+1)
          if(key==='dfid'&&value&&value.length<=256)device.dfid=value
          if(key==='t1'&&'device'in session&&value&&value.length<=512)session.t1=value
        }
        const chunks:Uint8Array[]=[];let size=0
        if(response.body)for await(const chunk of response.body){size+=chunk.byteLength;if(size>32*1024*1024)throw new AccountError('ACCOUNT_RESPONSE_TOO_LARGE');chunks.push(chunk)}
        let data:Record<string,unknown>|null=null;try{data=record(JSON.parse(Buffer.concat(chunks).toString('utf8')))}catch{}
        if(!data)throw new AccountError('ACCOUNT_RESPONSE_INVALID')
        return data
      }catch(error){if(error instanceof AccountError)throw error;throw new AccountError(signal?.aborted?'ACCOUNT_CANCELLED':timer.aborted?'ACCOUNT_TIMEOUT':'ACCOUNT_NETWORK_ERROR')}
    });this.tail=work.then(()=>{},()=>{});return work
  }
}
export function parseAccountIdentity(body:Record<string,unknown>,userid:string):AccountInfo{
  const data=record(body.data);if(body.status!==1||!data)throw new AccountError('SESSION_INVALID')
  const id=data.userid??data.user_id;if(id!==undefined&&String(id)!==userid)throw new AccountError('ACCOUNT_IDENTITY_MISMATCH')
  const name=data.nickname??data.nick_name??data.username
  return{id:userid,nickname:typeof name==='string'?name.slice(0,200):null}
}
