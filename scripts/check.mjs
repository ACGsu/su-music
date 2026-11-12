import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url),output=path.join(root,'.p4/checks');
fs.mkdirSync(output,{recursive:true});
const packageFile=require.resolve('electron-vite/package.json'),vite=JSON.parse(fs.readFileSync(packageFile,'utf8'));
const testDirectory=path.join(root,'tests');
const testFiles=fs.existsSync(testDirectory)?fs.readdirSync(testDirectory).filter(name=>name.endsWith('.test.ts')).sort().map(name=>path.join(testDirectory,name)):[];
const steps=[...(testFiles.length?[['tests',['--test','--test-reporter=tap',...testFiles]]]:[]),['main-types',[require.resolve('typescript/bin/tsc'),'--noEmit','-p','tsconfig.node.json']],['vue-types',[require.resolve('vue-tsc/bin/vue-tsc.js'),'--noEmit','-p','tsconfig.web.json']],['build',[path.resolve(path.dirname(packageFile),typeof vite.bin==='string'?vite.bin:vite.bin['electron-vite']),'build']]];
const report={startedAt:new Date().toISOString(),node:process.version,network:'none',localTestsAvailable:testFiles.length>0,steps:[],passed:false};
if(!testFiles.length)console.log(JSON.stringify({name:'tests',status:'skipped',reason:'tests/ is local-only and contains no unit tests; checking types and build only'}));
for(const [name,args]of steps){
  const start=Date.now(),result=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:4*1024*1024});
  const outputText=(result.stdout??'')+(result.stderr??'');fs.writeFileSync(path.join(output,name+'.log'),outputText);
  const record={name,exitCode:result.status,error:result.error?.code??null,elapsedMs:Date.now()-start};
  if(name==='tests'){record.tests=Number(/^# tests (\d+)/m.exec(outputText)?.[1]??0);record.failed=Number(/^# fail (\d+)/m.exec(outputText)?.[1]??0);record.cancelled=Number(/^# cancelled (\d+)/m.exec(outputText)?.[1]??0)}
  report.steps.push(record);console.log(JSON.stringify(record));if(result.status!==0){console.log(outputText.slice(-14000));break}
}
report.passed=report.steps.length===steps.length&&report.steps.every(step=>step.exitCode===0);report.completedAt=new Date().toISOString();
fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({report:'.p4/checks/report.json',passed:report.passed}));if(!report.passed)process.exitCode=1;
