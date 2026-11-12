import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { DEFAULT_PREFERENCES, validatePreferencesPatch } from '../shared/contracts.ts'
import type { Collection, CollectionDetail, CollectionKind, Preferences, Track } from '../shared/contracts.ts'
import type { ImportedPlaylist, LibrarySearchItem, MatchResult, MatchStatus, OriginalTrack, TrackReference } from '../shared/music.ts'
import type { AccountInfo, AccountLibrary } from '../shared/account.ts'
import type {HistoryEntry,LocalTrack,ProblemTrack,PlaybackTarget} from '../shared/playback.ts'
import type {SourceCandidate} from '../shared/music.ts'
import {catalogTitle,publicTrack} from '../shared/track-name.ts'
import {compareCandidate,matchCandidates} from './music/matching.ts'
import {candidateTrack,reconcileCatalogPositions} from './music/catalog.ts'

export const SCHEMA_VERSION = 7
const MIGRATIONS: (string|((database:DatabaseSync)=>void))[] = [
  `CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  `CREATE TABLE collections (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL, account_key TEXT NOT NULL, source_key TEXT NOT NULL,
    name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('default','created','favorite','shared')),
    subtype TEXT CHECK(subtype IS NULL OR subtype='album'), pinned INTEGER NOT NULL DEFAULT 0,
    last_opened_at TEXT, directory_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE(provider,account_key,source_key)
  );
  CREATE TABLE collection_tracks (
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK(position>0), hash TEXT, title TEXT, filename TEXT,
    artist TEXT, album TEXT, duration_ms INTEGER, version TEXT, raw_json TEXT NOT NULL,
    PRIMARY KEY(collection_id,position)
  );
  CREATE INDEX collection_tracks_hash ON collection_tracks(hash);`,
  `CREATE TABLE p1_cache(kind TEXT NOT NULL,cache_key TEXT NOT NULL,value_json TEXT NOT NULL,expires_ms INTEGER NOT NULL,PRIMARY KEY(kind,cache_key));
  CREATE INDEX p1_cache_expiry ON p1_cache(expires_ms);
  CREATE TABLE p1_matches(collection_id TEXT NOT NULL,position INTEGER NOT NULL,original_signature TEXT NOT NULL,match_status TEXT NOT NULL,
    checked_at TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(collection_id,position),
    FOREIGN KEY(collection_id,position) REFERENCES collection_tracks(collection_id,position) ON DELETE CASCADE);`,
  `ALTER TABLE collections ADD COLUMN source_global_key TEXT;
   CREATE TABLE p2_directory(account_key TEXT NOT NULL,source_key TEXT NOT NULL,raw_json TEXT NOT NULL,PRIMARY KEY(account_key,source_key));`,
  `CREATE TABLE p3_bindings(collection_id TEXT NOT NULL,position INTEGER NOT NULL,slot TEXT NOT NULL CHECK(slot IN ('original','alternative','local')),original_signature TEXT NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(collection_id,position,slot),FOREIGN KEY(collection_id,position) REFERENCES collection_tracks(collection_id,position) ON DELETE CASCADE);
   CREATE TABLE p3_choice(collection_id TEXT NOT NULL,position INTEGER NOT NULL,slot TEXT NOT NULL,PRIMARY KEY(collection_id,position),FOREIGN KEY(collection_id,position) REFERENCES collection_tracks(collection_id,position) ON DELETE CASCADE);
   CREATE TABLE p3_local(id TEXT PRIMARY KEY,filename TEXT NOT NULL UNIQUE,name TEXT NOT NULL,format TEXT NOT NULL,duration_ms INTEGER,bitrate_kbps INTEGER,size INTEGER NOT NULL,mtime REAL NOT NULL,added_at TEXT NOT NULL);
   CREATE TABLE p3_history(id TEXT PRIMARY KEY,at TEXT NOT NULL,account_key TEXT NOT NULL,value_json TEXT NOT NULL);CREATE INDEX p3_history_account ON p3_history(account_key,at);
   CREATE TABLE p3_issues(collection_id TEXT NOT NULL,position INTEGER NOT NULL,reason TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(collection_id,position),FOREIGN KEY(collection_id,position) REFERENCES collection_tracks(collection_id,position) ON DELETE CASCADE);`,
  repairCatalogNames,
  database=>{
    if(!database.prepare('PRAGMA table_info(p3_bindings)').all().some(row=>row.name==='chosen_by_user')){
      database.exec('ALTER TABLE p3_bindings ADD COLUMN chosen_by_user INTEGER NOT NULL DEFAULT 0; UPDATE p3_bindings SET chosen_by_user=1;')
    }
  }
]

export interface CatalogChange {collectionId:string;positions:Map<number,number>;targetCollectionId?:string}
interface SavedCatalogTrack {
  original:OriginalTrack
  bindings:{slot:string;value:string;selected:boolean}[]
  choice:string|null
  match:MatchResult|null
  issue:{reason:string;at:string}|null
}
const signatureOf=(original:OriginalTrack):string=>createHash('sha256').update(JSON.stringify(original)).digest('hex')
const PRESENTATION_SELECT=`SELECT t.*,c.name AS collection_name,c.kind,m.match_status,m.checked_at,m.original_signature AS match_signature,m.result_json,i.reason AS playback_reason
  FROM collection_tracks t JOIN collections c ON c.id=t.collection_id
  LEFT JOIN p1_matches m ON m.collection_id=t.collection_id AND m.position=t.position
  LEFT JOIN p3_issues i ON i.collection_id=t.collection_id AND i.position=t.position`

function originalFromRow(row:Record<string,unknown>):OriginalTrack{
  return { position: Number(row.position), hash: row.hash == null ? null : String(row.hash), title: row.title == null ? null : String(row.title),
    filename: row.filename == null ? null : String(row.filename), artist: row.artist == null ? null : String(row.artist),
    album: row.album == null ? null : String(row.album), durationMs: row.duration_ms == null ? null : Number(row.duration_ms), version: row.version == null ? null : String(row.version) }
}
function repairCatalogNames(database:DatabaseSync):void{
  for(const row of database.prepare('SELECT collection_id,position,hash,title,filename,artist,album,duration_ms,version FROM collection_tracks').all()){
    const collectionId=String(row.collection_id),position=Number(row.position),before=originalFromRow(row)
    const original={...before,title:catalogTitle(before.title,before.filename,before.artist)}
    const beforeSignature=createHash('sha256').update(JSON.stringify(before)).digest('hex'),signature=createHash('sha256').update(JSON.stringify(original)).digest('hex')
    if(original.title!==before.title){
      database.prepare('UPDATE collection_tracks SET title=? WHERE collection_id=? AND position=?').run(original.title,collectionId,position)
      // Cosmetic normalization keeps an already accepted binding attached to the same track.
      database.prepare('UPDATE p3_bindings SET original_signature=? WHERE collection_id=? AND position=? AND original_signature=?').run(signature,collectionId,position,beforeSignature)
    }
    const cached=database.prepare('SELECT result_json FROM p1_matches WHERE collection_id=? AND position=? AND original_signature=?').get(collectionId,position,beforeSignature)
    if(!cached)continue
    try{
      const previous=JSON.parse(String(cached.result_json)) as MatchResult
      const updated=matchCandidates(original,previous.candidates.map(item=>item.candidate),previous.checkedAt)
      database.prepare('UPDATE p1_matches SET original_signature=?,match_status=?,result_json=? WHERE collection_id=? AND position=?').run(signature,updated.status,JSON.stringify(updated),collectionId,position)
      if(updated.automaticCandidate)database.prepare("DELETE FROM p3_issues WHERE collection_id=? AND position=? AND reason IN ('这首歌需要先选择版本。','原版暂不可用，可选择其他版本或关联本地文件。','版本需要对照')").run(collectionId,position)
    }catch{
      database.prepare('DELETE FROM p1_matches WHERE collection_id=? AND position=?').run(collectionId,position)
    }
  }
}

export class MusicDatabase {
  private db: DatabaseSync
  private catalogListeners=new Set<(changes:CatalogChange[])=>void>()
  readonly filename: string
  constructor(filename: string) {
    this.filename = path.resolve(filename)
    fs.mkdirSync(path.dirname(this.filename), { recursive: true })
    this.db = new DatabaseSync(this.filename)
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version)
    if (version > SCHEMA_VERSION) { this.db.close(); throw new Error('SCHEMA_TOO_NEW') }
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
      for (let index = version; index < MIGRATIONS.length; index++) {
        this.db.exec('BEGIN IMMEDIATE')
        try { const migration=MIGRATIONS[index]!;if(typeof migration==='string')this.db.exec(migration);else migration(this.db); this.db.exec('PRAGMA user_version=' + (index + 1)); this.db.exec('COMMIT') }
        catch (error) { this.db.exec('ROLLBACK'); throw error }
      }
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
    } catch (error) { this.db.close(); throw error }
  }
  close(): void { this.db.close() }
  onCatalogChanged(listener:(changes:CatalogChange[])=>void):()=>void{this.catalogListeners.add(listener);return()=>this.catalogListeners.delete(listener)}
  private notifyCatalog(changes:CatalogChange[]):void{for(const listener of this.catalogListeners)try{listener(changes)}catch{}}
  sqliteVersion(): string { return String(this.db.prepare('SELECT sqlite_version() AS version').get()!.version) }
  schemaVersion(): number { return Number(this.db.prepare('PRAGMA user_version').get()!.user_version) }
  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)
    if (!row) return fallback
    try { return JSON.parse(String(row.value)) as T } catch { return fallback }
  }
  setSetting(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value))
  }
  getPreferences(): Preferences {
    const stored = this.getSetting<unknown>('preferences', {})
    try { return { ...DEFAULT_PREFERENCES, ...validatePreferencesPatch(stored) } }
    catch { return { ...DEFAULT_PREFERENCES } }
  }
  setPreferences(input: unknown): Preferences {
    const patch = validatePreferencesPatch(input)
    const next = { ...this.getPreferences(), ...patch }
    this.setSetting('preferences', next)
    return next
  }
  currentAccountKey(): string { const key=this.getSetting<unknown>('active-account-key','local');return typeof key==='string'&&(key==='local'||/^kg:[1-9]\d{0,15}$/.test(key))?key:'local' }
  selectAccount(account: AccountInfo): void {
    if(!/^[1-9]\d{0,15}$/.test(account.id))throw new Error('INVALID_ACCOUNT')
    this.setSetting('active-account-key','kg:'+account.id)
    this.setSetting('cached-kugou-account',account)
    this.setSetting('last-sync-at',this.getSetting<string|null>('last-sync:'+account.id,null))
  }
  getCollections(accountKey = this.currentAccountKey()): Collection[] {
    return this.db.prepare(`SELECT c.*, COUNT(t.position) AS position_count FROM collections c
      LEFT JOIN collection_tracks t ON t.collection_id=c.id WHERE c.account_key=? OR (?=1 AND c.account_key='local' AND c.kind='shared') GROUP BY c.id ORDER BY c.directory_order,c.id`).all(accountKey,accountKey.startsWith('kg:')?1:0).map(row => ({
      id: String(row.id), name: String(row.name), provider: String(row.provider), kind: String(row.kind) as CollectionKind,
      subtype: row.subtype === 'album' ? 'album' : null, pinned: row.pinned === 1,
      lastOpenedAt: row.last_opened_at == null ? null : String(row.last_opened_at), positionCount: Number(row.position_count)
    }))
  }
  getCollection(id: string, accountKey = this.currentAccountKey()): CollectionDetail | null {
    const collection = this.getCollections(accountKey).find(row => row.id === id)
    if (!collection) return null
    const tracks=this.db.prepare(PRESENTATION_SELECT+' WHERE t.collection_id=? ORDER BY t.position').all(id).map(row=>this.presentTrack(row))
    return { collection, tracks }
  }
  getTrackPresentation(reference:TrackReference,accountKey=this.currentAccountKey()):{track:Track;collectionName:string}|null{
    const row=this.db.prepare(PRESENTATION_SELECT+" WHERE (c.account_key=? OR (?=1 AND c.account_key='local' AND c.kind='shared')) AND t.collection_id=? AND t.position=?").get(accountKey,accountKey.startsWith('kg:')?1:0,reference.collectionId,reference.position)
    return row?{track:this.presentTrack(row),collectionName:String(row.collection_name)}:null
  }
  private presentTrack(row:Record<string,unknown>):Track{
    const original=originalFromRow(row),signature=signatureOf(original),reference={collectionId:String(row.collection_id),position:original.position}
    const binding=this.bindingFor(reference,signature)
    let track=publicTrack({position:original.position,title:original.title,filename:original.filename,artist:original.artist,album:original.album,durationMs:original.durationMs,version:original.version}),ready=false,choice:Track['playbackChoice'],issue=row.playback_reason==null?null:String(row.playback_reason)
    if(binding?.target.kind==='candidate'){
      const candidate=binding.candidate??this.getSourceCache<SourceCandidate>('candidate',binding.target.candidate.providerId+':'+binding.target.candidate.sourceId+':'+binding.target.candidate.trackId)
      if(candidate){ready=true;choice=binding.selected?'selected':'matched';if(binding.selected)track=candidateTrack(candidate,original.position)}
    }else if(binding?.target.kind==='local'){
      const local=this.getLocal(binding.target.localId);choice='local'
      if(local){track={position:original.position,title:local.name,filename:null,artist:null,album:null,durationMs:local.durationMs,version:null};ready=!local.missing}
      if(!local||local.missing)issue='本地文件缺失或已改变'
    }
    if(!binding&&row.match_signature===signature&&row.result_json){
      try{const match=JSON.parse(String(row.result_json)) as MatchResult;ready=Boolean(match.automaticCandidate);if(ready)choice='matched'}catch{}
    }
    return{...track,matchStatus:row.match_status==null?'unchecked':String(row.match_status) as MatchStatus,matchCheckedAt:row.checked_at==null?null:String(row.checked_at),playbackReady:ready,...(choice?{playbackChoice:choice}:{}),playbackIssue:issue}
  }
  // This is main-process-only. No renderer IPC exposes catalog writes.
  insertCollection(row: { id: string; name: string; kind: CollectionKind; provider: string; accountKey: string; sourceKey: string; subtype?: 'album'; order?: number }): void {
    this.db.prepare('INSERT INTO collections(id,provider,account_key,source_key,name,kind,subtype,directory_order) VALUES(?,?,?,?,?,?,?,?)')
      .run(row.id, row.provider, row.accountKey, row.sourceKey, row.name, row.kind, row.subtype ?? null, row.order ?? 0)
  }
  insertTrack(id: string, track: Track & { hash?: string; raw?: unknown }): void {
    this.db.prepare('INSERT INTO collection_tracks(collection_id,position,hash,title,filename,artist,album,duration_ms,version,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, track.position, track.hash ?? null, catalogTitle(track.title,track.filename,track.artist), track.filename, track.artist, track.album, track.durationMs, track.version, JSON.stringify(track.raw ?? {}))
  }
  private readCatalogMemory(collectionId:string):Map<number,SavedCatalogTrack>{
    const memory=new Map<number,SavedCatalogTrack>()
    for(const row of this.db.prepare('SELECT * FROM collection_tracks WHERE collection_id=? ORDER BY position').all(collectionId))memory.set(Number(row.position),{original:originalFromRow(row),bindings:[],choice:null,match:null,issue:null})
    for(const row of this.db.prepare('SELECT * FROM p3_bindings WHERE collection_id=?').all(collectionId)){
      const saved=memory.get(Number(row.position));if(saved&&signatureOf(saved.original)===row.original_signature)saved.bindings.push({slot:String(row.slot),value:String(row.value_json),selected:row.chosen_by_user===1})
    }
    for(const row of this.db.prepare('SELECT position,slot FROM p3_choice WHERE collection_id=?').all(collectionId)){const saved=memory.get(Number(row.position));if(saved)saved.choice=String(row.slot)}
    for(const row of this.db.prepare('SELECT * FROM p1_matches WHERE collection_id=?').all(collectionId)){
      const saved=memory.get(Number(row.position));if(saved&&signatureOf(saved.original)===row.original_signature)try{saved.match=JSON.parse(String(row.result_json)) as MatchResult}catch{}
    }
    for(const row of this.db.prepare('SELECT * FROM p3_issues WHERE collection_id=?').all(collectionId)){const saved=memory.get(Number(row.position));if(saved)saved.issue={reason:String(row.reason),at:String(row.at)}}
    return memory
  }
  private replaceCatalogTracks(collectionId:string,tracks:(OriginalTrack&{raw:unknown})[],importedMemory?:Map<number,SavedCatalogTrack>):CatalogChange{
    const memory=this.readCatalogMemory(collectionId)
    const originals=tracks.map(track=>({position:track.position,hash:track.hash??null,title:catalogTitle(track.title,track.filename,track.artist),filename:track.filename,artist:track.artist,album:track.album,durationMs:track.durationMs,version:track.version}))
    const positions=reconcileCatalogPositions([...memory.values()].map(saved=>saved.original),originals)
    for(const table of ['p1_matches','p3_bindings','p3_choice','p3_issues'])this.db.prepare('DELETE FROM '+table+' WHERE collection_id=?').run(collectionId)
    const upsert=this.db.prepare('INSERT INTO collection_tracks(collection_id,position,hash,title,filename,artist,album,duration_ms,version,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(collection_id,position) DO UPDATE SET hash=excluded.hash,title=excluded.title,filename=excluded.filename,artist=excluded.artist,album=excluded.album,duration_ms=excluded.duration_ms,version=excluded.version,raw_json=excluded.raw_json')
    for(const [index,original]of originals.entries())upsert.run(collectionId,original.position,original.hash,original.title,original.filename,original.artist,original.album,original.durationMs,original.version,JSON.stringify(tracks[index]!.raw))
    this.db.prepare('DELETE FROM collection_tracks WHERE collection_id=? AND position>?').run(collectionId,tracks.length)
    const restore=(saved:SavedCatalogTrack,position:number,onlySelected=false)=>{
      const original=originals[position-1]!;if(!original)return
      const reference={collectionId,position},signature=signatureOf(original)
      let match:MatchResult|null=null
      if(saved.match&&!onlySelected){match=matchCandidates(original,saved.match.candidates.map(item=>item.candidate),saved.match.checkedAt);this.saveMatch(reference,signature,match)}
      const existing=this.db.prepare('SELECT 1 FROM p3_bindings WHERE collection_id=? AND position=? AND chosen_by_user=1').get(collectionId,position)
      if(onlySelected&&existing)return
      const bindings=saved.bindings.filter(binding=>{
        if(onlySelected&&!binding.selected)return false
        if(!binding.selected&&binding.slot==='original'){try{const value=JSON.parse(binding.value);return value.candidate&&compareCandidate(original,value.candidate).decision==='matched'}catch{return false}}
        return true
      })
      for(const binding of bindings)this.db.prepare('INSERT INTO p3_bindings(collection_id,position,slot,original_signature,value_json,chosen_by_user) VALUES(?,?,?,?,?,?) ON CONFLICT(collection_id,position,slot) DO UPDATE SET original_signature=excluded.original_signature,value_json=excluded.value_json,chosen_by_user=excluded.chosen_by_user').run(collectionId,position,binding.slot,signature,binding.value,binding.selected?1:0)
      if(saved.choice&&bindings.some(binding=>binding.slot===saved.choice))this.db.prepare('INSERT INTO p3_choice(collection_id,position,slot) VALUES(?,?,?) ON CONFLICT(collection_id,position) DO UPDATE SET slot=excluded.slot').run(collectionId,position,saved.choice)
      if(saved.issue&&!onlySelected&&!(match?.automaticCandidate&&['这首歌需要先选择版本。','版本需要对照'].includes(saved.issue.reason)))this.db.prepare('INSERT INTO p3_issues(collection_id,position,reason,at) VALUES(?,?,?,?)').run(collectionId,position,saved.issue.reason,saved.issue.at)
    }
    for(const [before,after]of positions){const saved=memory.get(before);if(saved)restore(saved,after)}
    if(importedMemory){const importedPositions=reconcileCatalogPositions([...importedMemory.values()].map(saved=>saved.original),originals);for(const [before,after]of importedPositions){const saved=importedMemory.get(before);if(saved)restore(saved,after,true)}}
    return{collectionId,positions}
  }
  replaceSharedPlaylist(playlist: ImportedPlaylist): CollectionDetail {
    if (!playlist.sourceKey || !playlist.name || !playlist.tracks.length || playlist.tracks.some((track, index) => track.position !== index + 1)) throw new Error('SHARE_COUNT_MISMATCH')
    const linked=this.db.prepare("SELECT id FROM collections WHERE provider='kugou' AND account_key=? AND source_global_key=? AND kind<>'shared'").get(this.currentAccountKey(),playlist.sourceKey)
    if(linked)return this.getCollection(String(linked.id))!
    const previous = this.db.prepare("SELECT id,kind FROM collections WHERE provider='kugou' AND account_key='local' AND source_key=?").get(playlist.sourceKey)
    if (previous && previous.kind !== 'shared') throw new Error('IMPORT_IDENTITY_CONFLICT')
    const id = previous ? String(previous.id) : 'shared-' + createHash('sha256').update('kugou\nlocal\n' + playlist.sourceKey).digest('hex').slice(0, 32)
    this.db.exec('BEGIN IMMEDIATE')
    let change:CatalogChange|null=null
    try {
      if (previous) this.db.prepare('UPDATE collections SET name=? WHERE id=?').run(playlist.name, id)
      else {
        const order = Number(this.db.prepare('SELECT COALESCE(MAX(directory_order),0)+1 AS n FROM collections').get()!.n)
        this.insertCollection({ id, name: playlist.name, kind: 'shared', provider: 'kugou', accountKey: 'local', sourceKey: playlist.sourceKey, order })
      }
      change=this.replaceCatalogTracks(id,playlist.tracks)
      this.setSetting('share-import:' + id, { originalUrl: playlist.originalUrl, observedAt: playlist.observedAt, positionCount: playlist.tracks.length })
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    if(change)this.notifyCatalog([change])
    return this.getCollection(id)!
  }
  getOriginal(reference: TrackReference, accountKey = this.currentAccountKey()): OriginalTrack | null {
    const row = this.db.prepare("SELECT t.* FROM collection_tracks t JOIN collections c ON c.id=t.collection_id WHERE (c.account_key=? OR (?=1 AND c.account_key='local' AND c.kind='shared')) AND t.collection_id=? AND t.position=?").get(accountKey,accountKey.startsWith('kg:')?1:0, reference.collectionId, reference.position)
    if (!row) return null
    return originalFromRow(row)
  }
  getSourceCache<T>(kind: string, key: string): T | null {
    const row = this.db.prepare('SELECT value_json,expires_ms FROM p1_cache WHERE kind=? AND cache_key=?').get(kind, key)
    if (!row) return null
    if (Number(row.expires_ms) <= Date.now()) { this.db.prepare('DELETE FROM p1_cache WHERE kind=? AND cache_key=?').run(kind, key); return null }
    try { return JSON.parse(String(row.value_json)) as T } catch { return null }
  }
  setSourceCache(kind: string, key: string, value: unknown, ttlMs: number): void {
    this.db.prepare('INSERT INTO p1_cache(kind,cache_key,value_json,expires_ms) VALUES(?,?,?,?) ON CONFLICT(kind,cache_key) DO UPDATE SET value_json=excluded.value_json,expires_ms=excluded.expires_ms')
      .run(kind, key, JSON.stringify(value), Date.now() + ttlMs)
    this.db.prepare('DELETE FROM p1_cache WHERE expires_ms<=?').run(Date.now())
    this.db.prepare('DELETE FROM p1_cache WHERE rowid IN (SELECT rowid FROM p1_cache WHERE kind=? ORDER BY expires_ms ASC LIMIT MAX(0,(SELECT COUNT(*) FROM p1_cache WHERE kind=?)-2000))').run(kind, kind)
  }
  getMatch(reference: TrackReference, signature: string): MatchResult | null {
    const row = this.db.prepare('SELECT result_json,checked_at FROM p1_matches WHERE collection_id=? AND position=? AND original_signature=?').get(reference.collectionId, reference.position, signature)
    if (!row || Date.parse(String(row.checked_at)) + 86_400_000 <= Date.now()) return null
    try { return JSON.parse(String(row.result_json)) as MatchResult } catch { return null }
  }
  saveMatch(reference: TrackReference, signature: string, result: MatchResult): void {
    this.db.prepare('INSERT INTO p1_matches(collection_id,position,original_signature,match_status,checked_at,result_json) VALUES(?,?,?,?,?,?) ON CONFLICT(collection_id,position) DO UPDATE SET original_signature=excluded.original_signature,match_status=excluded.match_status,checked_at=excluded.checked_at,result_json=excluded.result_json')
      .run(reference.collectionId, reference.position, signature, result.status, result.checkedAt, JSON.stringify(result))
  }
  searchLibrary(query: string, accountKey = this.currentAccountKey()): LibrarySearchItem[] {
    const pattern = '%' + query.replace(/[\\%_]/g, '\\$&') + '%'
    return this.db.prepare(PRESENTATION_SELECT+` LEFT JOIN p3_choice choice ON choice.collection_id=t.collection_id AND choice.position=t.position
      LEFT JOIN p3_bindings b ON b.collection_id=choice.collection_id AND b.position=choice.position AND b.slot=choice.slot
      LEFT JOIN p3_local local ON local.id=json_extract(b.value_json,'$.target.localId')
      WHERE (c.account_key=? OR (?=1 AND c.account_key='local' AND c.kind='shared')) AND (t.title LIKE ? ESCAPE '\\' OR t.filename LIKE ? ESCAPE '\\' OR t.artist LIKE ? ESCAPE '\\' OR t.album LIKE ? ESCAPE '\\' OR json_extract(b.value_json,'$.candidate.title') LIKE ? ESCAPE '\\' OR json_extract(b.value_json,'$.candidate.album') LIKE ? ESCAPE '\\' OR json_extract(b.value_json,'$.candidate.artists') LIKE ? ESCAPE '\\' OR local.name LIKE ? ESCAPE '\\') ORDER BY c.directory_order,t.position LIMIT 100`).all(accountKey,accountKey.startsWith('kg:')?1:0, pattern, pattern, pattern, pattern,pattern,pattern,pattern,pattern).map(row => ({
      reference: { collectionId: String(row.collection_id), position: Number(row.position) }, collectionName: String(row.collection_name), collectionKind: String(row.kind),
      track: this.presentTrack(row)
    }))
  }
  setPinned(id: string, pinned: boolean): void {
    if(!this.getCollection(id))throw new Error('TRACK_NOT_FOUND')
    this.db.prepare('UPDATE collections SET pinned=? WHERE id=?').run(pinned?1:0,id)
  }
  markOpened(id: string): void { if(this.getCollection(id))this.db.prepare('UPDATE collections SET last_opened_at=? WHERE id=?').run(new Date().toISOString(),id) }
  replaceAccountLibrary(library: AccountLibrary): { added:number;removed:number;positionCount:number } {
    const accountKey='kg:'+library.owner.id
    if(!library.directoryVerified||library.unknownClassifications!==0||library.rawDirectoryCount!==library.collections.length||!Array.isArray(library.collections))throw new Error('INCOMPLETE_ACCOUNT_LIBRARY')
    const old=this.db.prepare("SELECT id,source_key FROM collections WHERE account_key=? AND kind<>'shared'").all(accountKey)
    if(old.length&&!library.collections.length)throw new Error('EMPTY_ACCOUNT_LIBRARY')
    const oldKeys=new Set(old.map(row=>String(row.source_key))),newKeys=new Set(library.collections.map(row=>row.sourceKey))
    if(newKeys.size!==library.collections.length)throw new Error('DUPLICATE_ACCOUNT_COLLECTION')
    const changes:CatalogChange[]=[]
    this.db.exec('BEGIN IMMEDIATE')
    try{
      for(const collection of library.collections){
        if(collection.reportedCount!==collection.tracks.length||collection.tracks.some((track,index)=>track.position!==index+1))throw new Error('INCOMPLETE_ACCOUNT_TRACKS')
        const existing=this.db.prepare('SELECT id FROM collections WHERE account_key=? AND provider=? AND source_key=?').get(accountKey,'kugou',collection.sourceKey)
        const shared=collection.sourceGlobalKey?this.db.prepare("SELECT id FROM collections WHERE account_key='local' AND kind='shared' AND provider='kugou' AND source_key=?").get(collection.sourceGlobalKey):null
        const id=existing?String(existing.id):shared?String(shared.id):'kg-'+createHash('sha256').update(accountKey+'\n'+collection.sourceKey).digest('hex').slice(0,32)
        const sharedMemory=shared&&existing&&String(shared.id)!==id?this.readCatalogMemory(String(shared.id)):undefined
        if(shared&&existing&&String(shared.id)!==id){
          const pin=this.db.prepare('SELECT pinned FROM collections WHERE id=?').get(String(shared.id))
          if(pin?.pinned===1)this.db.prepare('UPDATE collections SET pinned=1 WHERE id=?').run(id)
          this.db.prepare('DELETE FROM collections WHERE id=?').run(String(shared.id))
        }
        if(shared&&!existing){this.db.prepare('UPDATE collections SET account_key=?,source_key=? WHERE id=?').run(accountKey,collection.sourceKey,id)}
        if(!existing&&!shared)this.insertCollection({id,name:collection.name,kind:collection.kind,provider:'kugou',accountKey,sourceKey:collection.sourceKey,subtype:collection.subtype??undefined,order:collection.order})
        this.db.prepare('UPDATE collections SET name=?,kind=?,subtype=?,directory_order=?,source_global_key=? WHERE id=?').run(collection.name,collection.kind,collection.subtype,collection.order,collection.sourceGlobalKey,id)
        changes.push(this.replaceCatalogTracks(id,collection.tracks,sharedMemory))
        if(sharedMemory&&shared)changes.push({collectionId:String(shared.id),targetCollectionId:id,positions:reconcileCatalogPositions([...sharedMemory.values()].map(saved=>saved.original),collection.tracks)})
        this.db.prepare('INSERT INTO p2_directory(account_key,source_key,raw_json) VALUES(?,?,?) ON CONFLICT(account_key,source_key) DO UPDATE SET raw_json=excluded.raw_json').run(accountKey,collection.sourceKey,JSON.stringify(collection.raw))
      }
      for(const row of old)if(!newKeys.has(String(row.source_key))){this.db.prepare('DELETE FROM collections WHERE id=?').run(String(row.id));this.db.prepare('DELETE FROM p2_directory WHERE account_key=? AND source_key=?').run(accountKey,String(row.source_key));changes.push({collectionId:String(row.id),positions:new Map()})}
      this.selectAccount(library.owner);this.setSetting('last-sync-at',library.at);this.setSetting('last-sync:'+library.owner.id,library.at)
      this.db.exec('COMMIT')
    }catch(error){this.db.exec('ROLLBACK');throw error}
    this.notifyCatalog(changes)
    return{added:[...newKeys].filter(key=>!oldKeys.has(key)).length,removed:[...oldKeys].filter(key=>!newKeys.has(key)).length,positionCount:library.collections.reduce((sum,row)=>sum+row.tracks.length,0)}
  }
  originalSignature(reference:TrackReference):string|null{const original=this.getOriginal(reference);return original?createHash('sha256').update(JSON.stringify(original)).digest('hex'):null}
  saveBinding(reference:TrackReference,slot:'original'|'alternative'|'local',value:{target:PlaybackTarget;candidate?:SourceCandidate},selected=true):void{
    const signature=this.originalSignature(reference);if(!signature)throw new Error('TRACK_NOT_FOUND')
    this.db.exec('BEGIN IMMEDIATE')
    try{
    this.db.prepare('INSERT INTO p3_bindings(collection_id,position,slot,original_signature,value_json,chosen_by_user) VALUES(?,?,?,?,?,?) ON CONFLICT(collection_id,position,slot) DO UPDATE SET original_signature=excluded.original_signature,value_json=excluded.value_json,chosen_by_user=excluded.chosen_by_user').run(reference.collectionId,reference.position,slot,signature,JSON.stringify(value),selected?1:0)
    this.db.prepare('INSERT INTO p3_choice(collection_id,position,slot) VALUES(?,?,?) ON CONFLICT(collection_id,position) DO UPDATE SET slot=excluded.slot').run(reference.collectionId,reference.position,slot)
    this.clearIssue(reference);this.db.exec('COMMIT')
    }catch(error){this.db.exec('ROLLBACK');throw error}
  }
  getBinding(reference:TrackReference):{slot:'original'|'alternative'|'local';target:PlaybackTarget;candidate?:SourceCandidate;selected:boolean}|null{
    const signature=this.originalSignature(reference);if(!signature)return null
    return this.bindingFor(reference,signature)
  }
  private bindingFor(reference:TrackReference,signature:string):{slot:'original'|'alternative'|'local';target:PlaybackTarget;candidate?:SourceCandidate;selected:boolean}|null{
    const choice=this.db.prepare('SELECT slot FROM p3_choice WHERE collection_id=? AND position=?').get(reference.collectionId,reference.position)
    const row=this.db.prepare('SELECT slot,value_json,chosen_by_user FROM p3_bindings WHERE collection_id=? AND position=? AND slot=? AND original_signature=?').get(reference.collectionId,reference.position,String(choice?.slot??'original'),signature)
    if(!row)return null
    try{return{slot:String(row.slot) as 'original'|'alternative'|'local',...JSON.parse(String(row.value_json)),selected:row.chosen_by_user===1}}catch{return null}
  }
  restoreOriginal(reference:TrackReference):void{
    if(!this.getOriginal(reference))throw new Error('TRACK_NOT_FOUND')
    this.db.exec('BEGIN IMMEDIATE')
    try{
    this.db.prepare("DELETE FROM p3_bindings WHERE collection_id=? AND position=? AND slot<>'original'").run(reference.collectionId,reference.position)
    this.db.prepare("UPDATE p3_bindings SET chosen_by_user=0 WHERE collection_id=? AND position=? AND slot='original'").run(reference.collectionId,reference.position)
    this.db.prepare("INSERT INTO p3_choice(collection_id,position,slot) VALUES(?,?,'original') ON CONFLICT(collection_id,position) DO UPDATE SET slot='original'").run(reference.collectionId,reference.position)
    this.clearIssue(reference);this.db.exec('COMMIT')
    }catch(error){this.db.exec('ROLLBACK');throw error}
  }
  registerLocal(record:LocalTrack&{filename:string;size:number;mtime:number}):LocalTrack{
    const old=this.db.prepare('SELECT id,added_at FROM p3_local WHERE filename=?').get(record.filename)
    const id=old?String(old.id):record.id,addedAt=old?String(old.added_at):record.addedAt
    this.db.prepare('INSERT INTO p3_local(id,filename,name,format,duration_ms,bitrate_kbps,size,mtime,added_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(filename) DO UPDATE SET name=excluded.name,format=excluded.format,duration_ms=excluded.duration_ms,bitrate_kbps=excluded.bitrate_kbps,size=excluded.size,mtime=excluded.mtime').run(id,record.filename,record.name,record.format,record.durationMs,record.bitrateKbps,record.size,record.mtime,addedAt)
    return{id,name:record.name,format:record.format,durationMs:record.durationMs,bitrateKbps:record.bitrateKbps,missing:false,addedAt}
  }
  getLocal(id:string): (LocalTrack&{filename:string;size:number;mtime:number})|null{
    const row=this.db.prepare('SELECT * FROM p3_local WHERE id=?').get(id);if(!row)return null
    const filename=String(row.filename);let missing=false
    try{const stat=fs.statSync(filename);missing=!stat.isFile()||stat.size!==Number(row.size)||stat.mtimeMs!==Number(row.mtime)}catch{missing=true}
    return{id:String(row.id),filename,name:String(row.name),format:String(row.format),durationMs:row.duration_ms==null?null:Number(row.duration_ms),bitrateKbps:row.bitrate_kbps==null?null:Number(row.bitrate_kbps),size:Number(row.size),mtime:Number(row.mtime),addedAt:String(row.added_at),missing}
  }
  getLocalTracks():LocalTrack[]{return this.db.prepare('SELECT id FROM p3_local ORDER BY added_at DESC LIMIT 2000').all().map(row=>this.getLocal(String(row.id))!).map(({filename:_filename,size:_size,mtime:_mtime,...publicRecord})=>publicRecord)}
  removeLocal(id:string):void{this.db.prepare('DELETE FROM p3_local WHERE id=?').run(id)}
  addHistory(entry:HistoryEntry,accountKey=this.currentAccountKey()):void{
    this.db.prepare('INSERT INTO p3_history(id,at,account_key,value_json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json').run(entry.id,entry.at,accountKey,JSON.stringify(entry))
    this.db.prepare('DELETE FROM p3_history WHERE id IN (SELECT id FROM p3_history WHERE account_key=? ORDER BY at DESC LIMIT -1 OFFSET 1000)').run(accountKey)
  }
  getHistory():HistoryEntry[]{return this.db.prepare('SELECT value_json FROM p3_history WHERE account_key=? ORDER BY at DESC LIMIT 200').all(this.currentAccountKey()).flatMap(row=>{try{return[JSON.parse(String(row.value_json)) as HistoryEntry]}catch{return[]}})}
  getHistoryEntry(id:string):HistoryEntry|null{return this.getHistory().find(item=>item.id===id)??null}
  clearHistory():void{this.db.prepare('DELETE FROM p3_history WHERE account_key=?').run(this.currentAccountKey())}
  setIssue(reference:TrackReference,reason:string):void{
    if(!this.getOriginal(reference))return
    this.db.prepare('INSERT INTO p3_issues(collection_id,position,reason,at) VALUES(?,?,?,?) ON CONFLICT(collection_id,position) DO UPDATE SET reason=excluded.reason,at=excluded.at').run(reference.collectionId,reference.position,reason.slice(0,500),new Date().toISOString())
  }
  clearIssue(reference:TrackReference):void{this.db.prepare('DELETE FROM p3_issues WHERE collection_id=? AND position=?').run(reference.collectionId,reference.position)}
  getIssues():ProblemTrack[]{
    const rows=this.db.prepare("SELECT t.collection_id,t.position,t.title,t.filename,c.name,m.match_status,i.reason FROM collection_tracks t JOIN collections c ON c.id=t.collection_id LEFT JOIN p1_matches m ON m.collection_id=t.collection_id AND m.position=t.position LEFT JOIN p3_issues i ON i.collection_id=t.collection_id AND i.position=t.position LEFT JOIN p3_choice choice ON choice.collection_id=t.collection_id AND choice.position=t.position WHERE (c.account_key=? OR (?=1 AND c.account_key='local' AND c.kind='shared')) AND (i.reason IS NOT NULL OR m.match_status IN ('needs_review','not_found') OR choice.slot='local') ORDER BY c.directory_order,t.position").all(this.currentAccountKey(),this.currentAccountKey().startsWith('kg:')?1:0)
    return rows.flatMap(row=>{
      const reference={collectionId:String(row.collection_id),position:Number(row.position)},binding=this.getBinding(reference)
      const local=binding?.target.kind==='local'?this.getLocal(binding.target.localId):null,missing=binding?.target.kind==='local'&&(!local||local.missing)
      if(!row.reason&&!missing&&binding)return[]
      if(!row.reason&&!missing&&row.match_status!=='needs_review'&&row.match_status!=='not_found')return[]
      return[{reference,title:String(row.title??row.filename??'标题待补充'),collectionName:String(row.name),reason:missing?'本地文件缺失或已改变':String(row.reason??(row.match_status==='not_found'?'原版暂不可用':'版本需要对照')),status:row.reason||missing?'error':String(row.match_status??'needs_review')}]
    }).slice(0,300)
  }
}
