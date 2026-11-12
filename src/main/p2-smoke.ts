import {app} from 'electron'
import type {BrowserWindow} from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {setTimeout as delay} from 'node:timers/promises'
import type {KugouTransport,KugouOperation} from './account/protocol.ts'
import {AccountError} from './account/protocol.ts'
import type {MusicDatabase} from './database.ts'
import type {AccountController} from './account/controller.ts'
import type {CredentialVault} from './vault.ts'
export class P2SmokeTransport implements KugouTransport{
  private root:string;private polls=0
  constructor(root:string){this.root=root}
  async call(operation:KugouOperation,_context:unknown,params:Record<string,string|number>={},signal?:AbortSignal):Promise<Record<string,unknown>>{
    if(signal?.aborted)throw new AccountError('ACCOUNT_CANCELLED')
    let mode='full';try{mode=JSON.parse(fs.readFileSync(path.join(this.root,'mode.json'),'utf8')).mode}catch{}
    if(operation==='qr_key'){this.polls=0;return{status:1,data:{qrcode:'p2-synthetic-qr'}}}
    if(operation==='qr_check'){this.polls++;return{status:1,data:{status:mode==='qr-wait'?1:mode==='confirm-wait'?2:mode==='refusal'?0:4,userid:'12345678',token:'p2-isolated-synthetic-token'}}}
    if(operation==='identity')return mode==='invalid'?{status:0}:{status:1,data:{userid:'12345678',nickname:'账号布局验证'}}
    const lists=[{listid:1,type:0,source:1,is_def:1,name:'默认收藏',count:0},{listid:2,type:0,source:1,is_def:2,name:'我喜欢',count:103},{listid:3,type:0,source:1,is_def:0,name:'窗边的音乐',count:2},...(mode==='removed'?[]:[{listid:4,type:1,source:2,is_def:0,name:'收藏原声带 · 专辑',count:3}])]
    if(operation==='directory')return{status:1,data:{userid:'12345678',list_count:lists.length,total_ver:1,info:lists}}
    if(mode==='timeout')throw new AccountError('ACCOUNT_TIMEOUT')
    const list=lists.find(item=>String(item.listid)===String(params.listid))!,page=Number(params.page),size=Number(params.pagesize),remaining=Math.max(0,Math.min(size,list.count-(page-1)*size))
    const tracks=Array.from({length:remaining},()=>({hash:'B'.repeat(32),name:'布局歌手 - 同一歌曲 (Original ver.)',singerinfo:[{name:'布局歌手'}],albuminfo:{name:'验证原声带'},timelen:42000}))
    return{status:1,data:{userid:'12345678',listid:list.listid,count:list.count,page,pagesize:size,list_ver:1,info:tracks}}
  }
}
export async function runP2Smoke(window:BrowserWindow,db:MusicDatabase,account:AccountController,vault:CredentialVault,phase:string):Promise<void>{
  const root=path.dirname(app.getPath('userData')),report:Record<string,unknown>={at:new Date().toISOString(),phase,packaged:app.isPackaged,network:'synthetic account transport; no external requests',schemaVersion:db.schemaVersion()}
  const evaluate=<T>(code:string):Promise<T>=>window.webContents.executeJavaScript(code,true) as Promise<T>
  const wait=async(check:()=>boolean):Promise<void>=>{const end=Date.now()+10000;while(Date.now()<end){if(check())return;await delay(30)}throw new Error('P2_SMOKE_WAIT')}
  const click=async(selector:string):Promise<void>=>{await evaluate('document.querySelector('+JSON.stringify(selector)+').click()');await delay(90)}
  const set=async(value:unknown):Promise<void>=>{assert((await evaluate<{ok:boolean}>('window.suMusic.setPreferences('+JSON.stringify(value)+')')).ok);await delay(120)}
  const capture=async(name:string):Promise<void>=>{await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await delay(150);fs.writeFileSync(path.join(root,name+'.png'),(await window.webContents.capturePage()).toPNG())}
  const mode=(value:string)=>fs.writeFileSync(path.join(root,'mode.json'),JSON.stringify({mode:value}))
  try{
    await set({currentPage:'settings',theme:'day'})
    if(phase==='resume'){
      await account.restore();await wait(()=>account.snapshot().sync.phase==='completed');assert.equal(db.getCollections().length,4);assert.equal(db.getCollections().find(item=>item.name==='我喜欢')!.positionCount,103)
      report.storedSessionRestored=true;report.repeatedSyncNoDuplicates=true
    }else{
      mode('qr-wait');await click('[data-start-login]');await wait(()=>account.snapshot().phase==='waiting_scan');await capture('day-qr');assert.equal(await evaluate<boolean>('Boolean(document.querySelector("[data-login-qr]"))'),true)
      mode('refusal')
      await wait(()=>account.snapshot().phase==='invalidated');assert.equal(await evaluate<boolean>('Boolean(document.querySelector("[data-login-qr]"))'),false);assert.equal(account.snapshot().qrPolling,false);report.refusalStopsPolling=true
      mode('confirm-wait');await click('[data-start-login]');await wait(()=>account.snapshot().phase==='waiting_confirm');await capture('waiting-confirm');mode('full')
      await wait(()=>account.snapshot().sync.phase==='completed');assert.equal(db.getCollections().length,4);assert.equal(account.snapshot().sync.positionCount,108);report.loginAndCompleteSync=true
      assert(vault.available());const token='p2-isolated-synthetic-token';assert(!fs.readFileSync(vault.filename).includes(token));assert(!(await evaluate<string>('window.suMusic.getState().then(value=>JSON.stringify(value))')).includes(token));report.realWindowsSessionEncryption=true
      await click('[data-nav="library"]');await delay(150);assert.equal(await evaluate<number>('document.querySelectorAll("[data-collections] .collection-card").length'),4);await capture('day-library')
      await click('[data-collections] .collection-card:nth-child(2)');await click('[data-pin-current]');assert(db.getCollections().find(item=>item.name==='我喜欢')!.pinned);report.pinAndDetail=true
      await click('.back-button');await set({theme:'night',libraryView:'list'});await capture('night-list')
      mode('timeout');await account.sync();assert.equal(account.snapshot().sync.phase,'failed');assert.equal(db.getCollections().length,4);report.failedSyncKeepsCache=true
      mode('removed');await account.sync();assert.equal(db.getCollections().length,3);report.cancelledFavoriteRemoved=true
      mode('full');await account.sync();assert.equal(db.getCollections().length,4);report.favoriteAddedAgain=true
      mode('full');report.sessionPreparedForResume=true
    }
    assert.equal(await evaluate<boolean>('typeof window.require!=="undefined"||typeof window.process!=="undefined"'),false);report.rendererRestricted=true
    if(phase==='resume'){
      await account.logout();assert.equal(fs.existsSync(vault.filename),false);assert.equal(db.getCollections().length,4);report.logoutKeepsCache=true
      await capture('logged-out-cache')
    }
    report.passed=true
  }catch(error){report.passed=false;report.error=error instanceof Error?error.message:'P2_SMOKE_FAILED';throw error}
  finally{fs.writeFileSync(path.join(root,'report-'+phase+'.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))}
}
