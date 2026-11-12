import type { CollectionKind, Track } from './contracts.ts'
export type LoginPhase='logged_out'|'stored_session'|'creating_qr'|'waiting_scan'|'waiting_confirm'|'verifying'|'authenticated'|'invalidated'|'local_deadline'|'cancelled'|'session_invalid'|'error'
export type SyncPhase='idle'|'reading_directory'|'reading_tracks'|'checking_directory'|'completed'|'failed'|'cancelled'
export interface AccountInfo { id:string; nickname:string|null }
export interface AccountState {
  phase:LoginPhase;account:AccountInfo|null;cachedAccount:AccountInfo|null;hasStoredSession:boolean
  qrImage:string|null;qrDeadline:number|null;qrPolling:boolean;qrChecks:number;message:string|null
  sync:{phase:SyncPhase;trigger:string|null;completedCollections:number;totalCollections:number;rawDirectoryCount:number|null;positionCount:number|null;lastSuccessAt:string|null;error:string|null;unknownClassifications:number;added:number;removed:number}
}
export interface AccountCollection {
  sourceKey:string;sourceGlobalKey:string|null;name:string;kind:Exclude<CollectionKind,'shared'>;subtype:'album'|null
  order:number;reportedCount:number;raw:unknown;tracks:(Track&{hash?:string;raw:unknown})[]
}
export interface AccountLibrary { owner:AccountInfo;at:string;collections:AccountCollection[];rawDirectoryCount:number;unknownClassifications:number;directoryVerified:boolean }
export interface Device { guid:string;mid:string;dev:string;dfid:string }
export interface KugouSession { schema:1;platform:'standard';savedAt:string;device:Device;userid:string;token:string;t1?:string }
