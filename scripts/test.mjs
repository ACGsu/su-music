import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),directory=path.join(root,'tests');
const requested=process.argv.slice(2),mode=requested.some(value=>['--desktop','--smoke','--dev'].includes(value))?'desktop-smoke.mjs':null;
if(!mode&&requested.length)throw new Error('UNKNOWN_UNIT_TEST_OPTION: '+requested.join(' '));
const runner=mode?path.join(directory,'scripts',mode):null;
const files=fs.existsSync(directory)?fs.readdirSync(directory).filter(name=>/\.test\.(ts|mjs)$/.test(name)).sort().map(name=>path.join(directory,name)):[];
if(runner?!fs.existsSync(runner):!files.length){
  console.error('LOCAL_TESTS_UNAVAILABLE: tests/ 仅保存在本机，不随 Git 提交；请恢复本机测试资料后重试。源码类型检查与构建可运行 node scripts/check.mjs。');
  process.exitCode=1;
}else{
  const args=runner?[runner,...requested.filter(value=>!['--smoke','--desktop'].includes(value))]:['--test','--test-reporter=tap',...files];
  const result=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',windowsHide:true});
  process.exitCode=result.status??1;
  if(!runner){
    for(const directory of ['.tmp/tests/unit','.tmp/tests','.tmp'])try{fs.rmdirSync(path.join(root,directory))}catch(error){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code))throw error}
  }
}
