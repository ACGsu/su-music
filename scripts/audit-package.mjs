import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {releaseDirectory,releaseRelative} from './release-paths.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url),builder=createRequire(require.resolve('electron-builder/package.json'));
let asar;try{asar=builder('@electron/asar')}catch{asar=createRequire(builder.resolve('app-builder-lib/package.json'))('@electron/asar')}
const read=file=>fs.readFileSync(path.join(root,file)),json=file=>JSON.parse(read(file)),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const record=file=>{const bytes=read(file),stat=fs.statSync(path.join(root,file));return{path:file,bytes:bytes.length,sha256:sha(bytes),modifiedAt:stat.mtime.toISOString()}};
const metadata=json('package.json'),archive=path.join(releaseRelative,'win-unpacked/resources/app.asar'),archivePath=path.join(root,archive);
const listing=asar.listPackage(archivePath).map(file=>file.replaceAll('\\','/').replace(/^\/+/,''));
const documents=['README.md','docs/AGENT.md','docs/KNOWN_LIMITATIONS.md'];
const licenses=fs.readdirSync(path.join(root,'licenses')).filter(file=>fs.statSync(path.join(root,'licenses',file)).isFile()).map(file=>'licenses/'+file);
assert(licenses.includes('licenses/THIRD_PARTY_NOTICES.md'),'THIRD_PARTY_NOTICES_MISSING');
const expected=['out/main/index.cjs','out/preload/index.cjs','out/renderer/index.html',...documents,'build/icon.ico',...licenses,...fs.readdirSync(path.join(root,'out/renderer/assets')).filter(file=>fs.statSync(path.join(root,'out/renderer/assets',file)).isFile()).map(file=>'out/renderer/assets/'+file)];
const files=expected.map(file=>{assert(listing.includes(file),'PACKAGE_FILE_MISSING: '+file);const bytes=asar.extractFile(archivePath,path.normalize(file));assert(bytes.equals(read(file)),'PACKAGE_DIFFERS_FROM_BUILD: '+file);return{path:file,sha256:sha(bytes)}});
assert(listing.every(file=>!/(^|\/)(\.v0|\.p[0-9]+|private|tests|scripts|v0|p0|node_modules)(\/|$)/.test(file)),'PRIVATE_OR_TEST_DIRECTORY_PACKAGED');
assert(!listing.some(file=>/\.(mp3|flac|wav|sqlite|bin|audio|part)$/i.test(file)),'PRIVATE_OR_AUDIO_FILE_PACKAGED');
const packagedMetadata=JSON.parse(asar.extractFile(archivePath,'package.json').toString());assert.equal(packagedMetadata.version,metadata.version);assert(!packagedMetadata.devDependencies);
assert(!listing.some(file=>/^user_?guide\.md$/i.test(file)),'OLD_USE_GUIDE_PACKAGED');
assert(!listing.some(file=>['AGENT.md','KNOWN_LIMITATIONS.md','THIRD_PARTY_NOTICES.md'].includes(file)),'OLD_ROOT_DOCUMENT_PACKAGED');
const executable=path.join(releaseRelative,'win-unpacked/Su Music.exe'),binary=read(executable);assert.equal(binary.readUInt16LE(binary.readUInt32LE(0x3c)+4),0x8664,'EXECUTABLE_NOT_WINDOWS_X64');
const installer=record(path.join(releaseRelative,`Su-Music-${metadata.version}-x64-setup.exe`)),smoke=[];
if(process.argv.includes('--smoke'))for(const stage of [1,2,3,4]){
  const report=json(`.p${stage}/smoke/latest-packaged.json`);assert(report.passed&&report.reports.length===(stage===4?6:2),'PACKAGED_SMOKE_REQUIRED: '+stage);
  assert(stage===4?report.mode==='packaged':report.packaged,'PACKAGED_SMOKE_MODE_INVALID');
  assert(report.reports.every(item=>item.passed&&item.packaged&&Date.parse(item.at)>Date.parse(installer.modifiedAt)),'SMOKE_PRECEDES_CURRENT_PACKAGE');
  smoke.push({stage,report});
}
let installation=null;
if(process.argv.includes('--install')){installation=json('.p4/install/validation.json');assert(installation.passed&&installation.sameApplicationPayloadAsRelease&&installation.registryRemoved&&installation.testProfilesPreserved);assert.equal(installation.installedArchiveSha256,sha(read(archive)))}
for(const document of [...documents,...licenses]){
  const destination=path.join(releaseDirectory,document);
  fs.mkdirSync(path.dirname(destination),{recursive:true});
  fs.copyFileSync(path.join(root,document),destination);
}
for(const document of ['KNOWN_LIMITATIONS.md','THIRD_PARTY_NOTICES.md'])fs.rmSync(path.join(releaseDirectory,document),{force:true});
fs.writeFileSync(path.join(root,installer.path+'.sha256'),installer.sha256+'  '+path.basename(installer.path)+'\n');
const report={at:new Date().toISOString(),version:metadata.version,passed:true,installer,archive:record(archive),executable:record(executable),files,licensesAndUseGuideIncluded:true,privateTestAndAudioDataExcluded:true,smoke,installation,codeSigned:false};
fs.mkdirSync(path.join(root,'.p4'),{recursive:true});fs.writeFileSync(path.join(root,'.p4/package-audit.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:true,version:metadata.version,files:files.length,smokeChecked:smoke.length===4,installationChecked:installation!==null,installerBytes:installer.bytes,installerSha256:installer.sha256}));
