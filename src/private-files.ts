import {realpathSync} from 'node:fs'
import {resolve} from 'node:path'
import {terminalCredentialFiles} from './terminal/profile.ts'

/** Host credential paths only; never copy their contents into task metadata. */
export function hostPrivateFiles():string[]{
 const files=terminalCredentialFiles()
 if(process.env.AGENTHUB_ENV_FILE)files.push(resolve(process.env.AGENTHUB_ENV_FILE))
 const paths=new Set(files)
 for(const path of files)try{paths.add(realpathSync(path))}catch{}
 return [...paths]
}

export function isHostPrivateFile(path:string){return hostPrivateFiles().includes(path)}
