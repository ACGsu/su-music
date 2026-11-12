import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import type {AppState} from '../shared/contracts.ts'
import type {MusicDatabase} from './database.ts'
export function recordP2State(root:string,state:AppState,db:MusicDatabase):void{
  const account=state.account
  if(!account)return
  const library=state.library.collections.map(collection=>({id:collection.id,name:collection.name,kind:collection.kind,subtype:collection.subtype,count:collection.positionCount,pinned:collection.pinned}))
  const summary={at:new Date().toISOString(),version:state.app.version,packaged:state.app.packaged,phase:account.phase,account:account.account,cachedAccount:account.cachedAccount,
    hasStoredSession:account.hasStoredSession,hasQr:!!account.qrImage,qrPolling:account.qrPolling,qrChecks:account.qrChecks,message:account.message,sync:account.sync,library,
    accountCollections:library.filter(item=>item.kind!=='shared').length,positionCount:state.library.positionCount,
    sequenceSha256:createHash('sha256').update(JSON.stringify(library.map(item=>({id:item.id,tracks:db.getCollection(item.id)?.tracks})))).digest('hex'),
    credentialDataInRenderer:false,environment:state.environment}
  fs.mkdirSync(root,{recursive:true});const temporary=path.join(root,'state.json.tmp');fs.writeFileSync(temporary,JSON.stringify(summary,null,2)+'\n');fs.renameSync(temporary,path.join(root,'state.json'))
  if(account.sync.phase==='completed'&&account.sync.lastSuccessAt){
    const file=path.join(root,'sync-'+account.sync.lastSuccessAt.replace(/[^\d]/g,'')+'.json');if(!fs.existsSync(file))fs.writeFileSync(file,JSON.stringify(summary,null,2)+'\n')
  }
}
