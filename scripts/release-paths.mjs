import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const projectRoot=fs.realpathSync(fileURLToPath(new URL('../',import.meta.url)));
export const project=JSON.parse(fs.readFileSync(path.join(projectRoot,'package.json'),'utf8'));
export const version=project.version;
if(typeof version!=='string'||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version))throw new Error('RELEASE_VERSION_INVALID');
export const releaseRelative=path.join('release',version);
export const releaseDirectory=path.join(projectRoot,releaseRelative);
export const packagedExecutable=path.join(releaseDirectory,'win-unpacked','Su Music.exe');
