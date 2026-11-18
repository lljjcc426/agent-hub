import {accessSync,constants,existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {createRequire} from 'node:module'
import {buildBackendPackage,installBackendPackage,readBackendPackage} from './plugin-package.ts'

/** Internal binding ID. The colon keeps it outside the public connection name space. */
export const bundledEngineId='builtin:opencode'

const source=fileURLToPath(new URL('../../plugins/backend-opencode/',import.meta.url))

function installedCLI(){
 if(process.platform!=='linux'&&process.platform!=='darwin')return undefined
 try{
  const path=createRequire(import.meta.url).resolve('opencode-ai/package.json')
  const {bin,version}=JSON.parse(readFileSync(path,'utf8'))
  const manifest=JSON.parse(readFileSync(join(source,'manifest.json'),'utf8'))
  if(version!==manifest.configSchema.properties.cliVersion.const)return undefined
  const command=join(dirname(path),bin.opencode)
  accessSync(command,constants.X_OK)
  return {command,cliVersion:String(version)}
 }catch{return undefined}
}
export const bundledCLI=installedCLI()

/** Images ship the adapter prebuilt. Source installations build it once in private storage. */
export async function prepareBundledOpenCode(stateDir:string){
 const distribution=fileURLToPath(new URL('../../dist/engines/opencode/',import.meta.url))
 if(existsSync(distribution)){
  const pkg=readBackendPackage(distribution)
  return installBackendPackage(pkg.directory,stateDir,pkg.digest)
 }
 const directory=mkdtempSync(join(tmpdir(),'roppo-opencode-pack-'))
 try{
  const pkg=await buildBackendPackage(join(source,'index.ts'),JSON.parse(readFileSync(join(source,'manifest.json'),'utf8')),join(directory,'package'))
  return installBackendPackage(pkg.directory,stateDir,pkg.digest)
 }finally{rmSync(directory,{recursive:true,force:true})}
}
