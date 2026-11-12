import type {AccountInfo,AccountState,Device,KugouSession} from '../../shared/account.ts'
import type {MusicDatabase} from '../database.ts'
import type {CredentialVault} from '../vault.ts'
import {AccountError,newKugouDevice,parseAccountIdentity,record,sessionValid} from './protocol.ts'
import type {KugouTransport} from './protocol.ts'
import {readKugouLibrary} from './library.ts'
import {qrImage} from './qr.ts'

const MESSAGES:Record<string,string>={ACCOUNT_TIMEOUT:'酷狗请求超时，已保留本地曲库。',ACCOUNT_NETWORK_ERROR:'暂时无法连接酷狗，已保留本地曲库。',SESSION_INVALID:'登录状态已失效，请重新扫码。',ACCOUNT_IDENTITY_MISMATCH:'返回账号与登录账号不一致，请重新扫码。',UNKNOWN_LIST_CLASSIFICATION:'发现待核对的歌单分类，本次未更新曲库。',DIRECTORY_CHANGED:'同步期间歌单发生变化，请再次刷新。',TRACKS_CHANGED:'同步期间曲目发生变化，请再次刷新。',ADDITIONAL_VERIFICATION_REQUIRED:'酷狗要求额外验证，请在官方客户端检查账号后重试。',CREDENTIAL_PROTECTION_UNAVAILABLE:'Windows 凭据保护暂不可用，无法保存登录。',ACCOUNT_CANCELLED:'操作已取消，已保留本地曲库。'}
export function accountMessage(error:unknown):string|null{return error instanceof AccountError?MESSAGES[error.code]??'酷狗资料未能读全，本次未更新曲库。':null}
const emptySync=():AccountState['sync']=>({phase:'idle',trigger:null,completedCollections:0,totalCollections:0,rawDirectoryCount:null,positionCount:null,lastSuccessAt:null,error:null,unknownClassifications:0,added:0,removed:0})
export class AccountController{
  private db:MusicDatabase;private vault:CredentialVault;private transport:KugouTransport;private notify:()=>void
  private device:Device;private session:KugouSession|null=null;private generation=0;private timer:ReturnType<typeof setTimeout>|null=null
  private loginAbort:AbortController|null=null;private syncAbort:AbortController|null=null;private syncJob:Promise<void>|null=null;private authJob:Promise<void>|null=null
  private stopped=false;private options:{pollMs:number;ttlMs:number;firstPollMs:number}
  private state:AccountState
  constructor(db:MusicDatabase,vault:CredentialVault,transport:KugouTransport,notify:()=>void,options:{pollMs?:number;ttlMs?:number;firstPollMs?:number}={}){
    this.db=db;this.vault=vault;this.transport=transport;this.notify=notify
    this.device=db.getSetting<Device>('kugou-device',newKugouDevice());this.db.setSetting('kugou-device',this.device)
    const cached=db.getSetting<AccountInfo|null>('cached-kugou-account',null),last=db.getSetting<string|null>('last-sync-at',null)
    this.state={phase:'logged_out',account:null,cachedAccount:cached,hasStoredSession:false,qrImage:null,qrDeadline:null,qrPolling:false,qrChecks:0,message:null,sync:{...emptySync(),lastSuccessAt:last}}
    this.options={pollMs:options.pollMs??2500,ttlMs:options.ttlMs??240000,firstPollMs:options.firstPollMs??1000}
  }
  snapshot():AccountState{return structuredClone(this.state)}
  private changed():void{if(!this.stopped)this.notify()}
  private stopQr():void{if(this.timer)clearTimeout(this.timer);this.timer=null;this.state.qrImage=null;this.state.qrDeadline=null;this.state.qrPolling=false}
  async restore():Promise<void>{
    const generation=++this.generation
    try{
      const loaded=await this.vault.read<unknown>();if(generation!==this.generation||this.stopped)return
      if(!loaded){this.state.phase='logged_out';this.changed();return}
      if(!sessionValid(loaded))throw new AccountError('SESSION_INVALID')
      this.session=loaded;this.device=loaded.device;this.state.hasStoredSession=true;this.state.phase='stored_session';this.changed()
      const controller=new AbortController();this.loginAbort=controller
      const account=parseAccountIdentity(await this.transport.call('identity',loaded,{},controller.signal),loaded.userid)
      if(generation!==this.generation||this.stopped)return
      this.state.account=account;this.state.cachedAccount=account;this.state.phase='authenticated';this.state.message=null;this.db.selectAccount(account);this.changed()
      void this.sync('startup')
    }catch(error){if(generation!==this.generation||this.stopped)return;this.state.phase=error instanceof AccountError&&error.code==='SESSION_INVALID'?'session_invalid':'error';this.state.message=accountMessage(error)??'本机登录资料暂时无法读取，请重试。';this.changed()}
  }
  async startLogin():Promise<void>{
    if(this.state.phase==='authenticated'||this.state.phase==='verifying')throw new AccountError('ACCOUNT_ALREADY_CONNECTED')
    if(this.state.phase==='creating_qr'||this.state.qrPolling)return
    const generation=++this.generation;this.stopQr();this.loginAbort?.abort();const controller=new AbortController();this.loginAbort=controller
    this.state.phase='creating_qr';this.state.qrChecks=0;this.state.message=null;this.changed()
    try{
      if(!this.vault.available())throw new AccountError('CREDENTIAL_PROTECTION_UNAVAILABLE')
      const response=await this.transport.call('qr_key',this.device,{},controller.signal),data=record(response.data),key=data?.qrcode
      if(typeof key!=='string'||!key||key.length>512||response.status!==1)throw new AccountError('QR_RESPONSE_INVALID')
      if(generation!==this.generation||this.stopped)return
      this.state.qrImage=qrImage(key);this.state.qrDeadline=Date.now()+this.options.ttlMs;this.state.qrPolling=true;this.state.phase='waiting_scan';this.changed()
      this.timer=setTimeout(()=>{void this.poll(key,generation,0)},this.options.firstPollMs)
    }catch(error){if(generation!==this.generation||this.stopped)return;this.stopQr();this.state.phase='error';this.state.message=accountMessage(error)??'二维码暂时无法生成，请重试。';this.changed()}
  }
  private async poll(key:string,generation:number,errors:number):Promise<void>{
    if(generation!==this.generation||!this.state.qrPolling||this.stopped)return
    if(Date.now()>=(this.state.qrDeadline??0)){this.stopQr();this.state.phase='local_deadline';this.state.message='等待时间已到，请重新生成二维码。';this.changed();return}
    try{
      this.state.qrChecks++
      const response=await this.transport.call('qr_check',this.device,{key},this.loginAbort?.signal),data=record(response.data),status=Number(data?.status)
      if(generation!==this.generation||!this.state.qrPolling||this.stopped)return
      if(status===0){this.stopQr();this.state.phase='invalidated';this.state.message='二维码已失效：可能过期或手机已取消确认，请重新生成。';this.changed();return}
      if(status===1||status===2){this.state.phase=status===1?'waiting_scan':'waiting_confirm';this.state.message=null;errors=0;this.changed()}
      else if(status===4){
        const token=data?.token,userid=String(data?.userid??'')
        if(typeof token!=='string'||!token||!Number.isSafeInteger(Number(userid))||!/^[1-9]\d{0,15}$/.test(userid))throw new AccountError('QR_RESPONSE_INVALID')
        this.stopQr();this.state.phase='verifying';this.changed()
        const session:KugouSession={schema:1,platform:'standard',savedAt:new Date().toISOString(),device:this.device,userid,token}
        this.authJob=(async()=>{
          const account=parseAccountIdentity(await this.transport.call('identity',session,{},this.loginAbort?.signal),userid)
          if(generation!==this.generation||this.stopped)return
          await this.vault.save(session)
          if(generation!==this.generation||this.stopped)return
          this.session=session;this.state.hasStoredSession=true;this.state.phase='authenticated';this.state.account=account;this.state.cachedAccount=account;this.state.message=null
          this.db.selectAccount(account);this.changed();void this.sync('login')
        })()
        await this.authJob;this.authJob=null;return
      }else throw new AccountError('QR_RESPONSE_INVALID')
    }catch(error){if(generation!==this.generation||this.stopped)return;errors++;if(errors>=3||error instanceof AccountError&&error.code==='ADDITIONAL_VERIFICATION_REQUIRED'||this.state.phase==='verifying'){
      this.stopQr();this.state.phase='error';this.state.message=accountMessage(error)??'二维码状态未能确认，请重新生成。';this.changed();return
    }}
    if(generation===this.generation&&this.state.qrPolling)this.timer=setTimeout(()=>{void this.poll(key,generation,errors)},this.options.pollMs)
  }
  cancelLogin():void{
    if(this.state.phase==='authenticated'||this.state.phase==='verifying')return
    this.generation++;this.loginAbort?.abort();this.stopQr();this.state.phase='cancelled';this.state.message='本机扫码已取消。';this.changed()
  }
  sync(trigger='manual'):Promise<void>{
    if(this.syncJob)return this.syncJob
    if(!this.session||this.state.phase!=='authenticated')return Promise.reject(new AccountError('ACCOUNT_REQUIRED'))
    const captured=this.session,controller=new AbortController();this.syncAbort=controller
    this.state.sync={...this.state.sync,phase:'reading_directory',trigger,completedCollections:0,totalCollections:0,error:null,unknownClassifications:0,added:0,removed:0};this.changed()
    const timer=setTimeout(()=>controller.abort(),10*60*1000)
    this.syncJob=(async()=>{
      try{
        const account=parseAccountIdentity(await this.transport.call('identity',captured,{},controller.signal),captured.userid)
        const library=await readKugouLibrary(this.transport,captured,account,controller.signal,value=>{Object.assign(this.state.sync,value);this.changed()})
        if(controller.signal.aborted||this.session!==captured||this.stopped)throw new AccountError('ACCOUNT_CANCELLED')
        const result=this.db.replaceAccountLibrary(library)
        this.state.cachedAccount=account;this.state.sync={...this.state.sync,phase:'completed',positionCount:result.positionCount,lastSuccessAt:library.at,error:null,added:result.added,removed:result.removed};this.changed()
      }catch(error){
        const code=error instanceof AccountError?error.code:'ACCOUNT_SYNC_FAILED'
        this.state.sync.phase=code==='ACCOUNT_CANCELLED'?'cancelled':'failed';this.state.sync.error=accountMessage(error)??'同步未能完成，已保留上次成功的曲库。'
        if(code==='SESSION_INVALID'){this.state.phase='session_invalid';this.state.account=null;this.state.message=accountMessage(error)}
        this.changed()
      }finally{clearTimeout(timer);this.syncAbort=null;this.syncJob=null}
    })();return this.syncJob
  }
  cancelSync():void{this.syncAbort?.abort()}
  async logout():Promise<void>{
    this.generation++;this.loginAbort?.abort();this.stopQr();this.syncAbort?.abort()
    await this.authJob?.catch(()=>{});await this.syncJob;await this.vault.clear()
    this.session=null;this.state.hasStoredSession=false;this.state.phase='logged_out';this.state.account=null;this.state.message='已退出登录，本地曲库仍可查看。';this.changed()
  }
  close():void{this.stopped=true;this.generation++;this.loginAbort?.abort();this.syncAbort?.abort();this.stopQr()}
}
