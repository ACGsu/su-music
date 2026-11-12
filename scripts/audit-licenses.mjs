import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url),project=JSON.parse(fs.readFileSync('package.json','utf8'));
const seen=new Map();
function inspect(directory){
  try{
    const actual=fs.realpathSync(directory),file=path.join(actual,'package.json');
    if(!fs.existsSync(file))return;
    const item=JSON.parse(fs.readFileSync(file,'utf8'));if(!item.name||!item.version)return;
    const key=item.name+'@'+item.version;if(seen.has(key))return;
    const license=typeof item.license==='string'?item.license:item.license?.type||item.licenses?.map(value=>value.type).join(' OR ')||null;
    const licenseFiles=fs.readdirSync(actual).filter(name=>/^(licen[sc]e|notice|copyright)([._-].*)?$/i.test(name)&&fs.statSync(path.join(actual,name)).isFile());
    seen.set(key,{name:item.name,version:item.version,license,engines:item.engines||{},main:item.main||null,exports:item.exports||null,
      repository:typeof item.repository==='string'?item.repository:item.repository?.url||null,licenseFiles,
      texts:licenseFiles.map(name=>({name,text:fs.readFileSync(path.join(actual,name),'utf8')}))});
  }catch{}
}
const store=path.resolve('node_modules/.pnpm');
for(const entry of fs.readdirSync(store,{withFileTypes:true})){
  if(!entry.isDirectory()||entry.name==='node_modules')continue;
  const modules=path.join(store,entry.name,'node_modules');if(!fs.existsSync(modules))continue;
  for(const name of fs.readdirSync(modules)){
    const directory=path.join(modules,name);
    if(name.startsWith('@')){for(const nested of fs.readdirSync(directory))inspect(path.join(directory,nested));}
    else inspect(directory);
  }
}
const direct=[];
for(const [name,version] of Object.entries(project.devDependencies)){
  const file=require.resolve(name+'/package.json');inspect(path.dirname(file));
  const record=seen.get(name+'@'+version);if(!record||!record.license||!record.licenseFiles.length)throw new Error('DIRECT_LICENSE_NOT_VERIFIED: '+name);
  direct.push({name,version,license:record.license,engines:record.engines,main:record.main,exports:record.exports,licenseFiles:record.licenseFiles});
}
const unresolved=[...seen.values()].filter(item=>!item.license).map(item=>item.name+'@'+item.version);
if(unresolved.length)throw new Error('UNIDENTIFIED_PACKAGE_LICENSES: '+unresolved.join(','));
const text=['# Su Music 第三方许可与依赖记录','',
'应用工程为私人项目。下列声明保留所用开源组件的版权及许可。Vue 代码打包进界面；Electron、Chromium、Node.js 与 SQLite 随桌面运行时分发。其余条目同时记录构建工具的许可，未将它们全部作为应用运行依赖。',''];
text.push('## GD 音乐台在线服务','','来源：GD音乐台(music.gdstudio.xyz)，文档：https://music-api.gdstudio.xyz/api.php。文档声明 CC BY-NC 4.0，要求标明出处并用于非商业学习。应用界面保留来源标注；适配器自行实现，不执行第三方音源脚本。','');
for(const [name,file]of [['KuGouMusicApi 协议参考','KuGouMusicApi.txt'],['qrcode 1.5.4','qrcode.txt'],['dijkstrajs 1.0.3','dijkstrajs.txt']])if(fs.existsSync(path.join('licenses',file)))text.push('## '+name,'','许可：MIT','',fs.readFileSync(path.join('licenses',file),'utf8'),'');
for(const item of [...seen.values()].sort((a,b)=>a.name.localeCompare(b.name))){
  text.push('## '+item.name+' '+item.version,'','许可：'+item.license,item.repository?'来源：'+item.repository:'');
  for(const license of item.texts)text.push('','### '+license.name,'',license.text);
  if(!item.texts.length)text.push('','该 npm 包仅附带 SPDX 许可声明；运行时所需版权文本另见所属组件的完整许可文件。');
  text.push('');
}
fs.writeFileSync(path.join('licenses','THIRD_PARTY_NOTICES.md'),text.join('\n'));
const moduleMetadata=JSON.parse(fs.readFileSync('node_modules/.modules.yaml','utf8'));
const report={at:new Date().toISOString(),direct,installedPackageCount:seen.size,unidentifiedLicenses:unresolved,
  packagesWithoutBundledLicenseText:[...seen.values()].filter(item=>!item.licenseFiles.length).map(item=>item.name+'@'+item.version),
  lockfileSha256:crypto.createHash('sha256').update(fs.readFileSync('pnpm-lock.yaml')).digest('hex'),
  packageStoreObserved:moduleMetadata.storeDir,runtimeNativeDatabase:'node:sqlite bundled with Electron; no separate native database addon'};
fs.mkdirSync('.p0',{recursive:true});fs.writeFileSync('.p0/dependency-audit.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({direct:direct.map(({name,version,license})=>({name,version,license})),installedPackageCount:seen.size,unidentifiedLicenses:unresolved,packagesWithoutBundledLicenseText:report.packagesWithoutBundledLicenseText.length,lockfileSha256:report.lockfileSha256}));
