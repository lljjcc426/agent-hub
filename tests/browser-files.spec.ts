import {it,expect,afterEach} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readdirSync,readFileSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {browserDownloads,browserDownload,browserUpload,browserFilename} from '../src/browser-files.ts';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})});
function fixture(){const root=mkdtempSync(join(tmpdir(),'roppo-browser-files-'));roots.push(root);mkdirSync(join(root,'downloads'));return root}
it('streams completed downloads, excludes in-progress files and refuses paths and symlinks',async()=>{
 const root=fixture();writeFileSync(join(root,'downloads','report.txt'),'中文 😀');writeFileSync(join(root,'downloads','partial.crdownload'),'unfinished');
 symlinkSync(join(root,'downloads','report.txt'),join(root,'downloads','link.txt'));
 expect(browserDownloads(root)).toEqual([{name:'report.txt'}]);
 const file=browserDownload(root,'report.txt'),chunks:Buffer[]=[];for await(const part of file.stream)chunks.push(part as Buffer);
 expect(Buffer.concat(chunks).toString()).toBe('中文 😀');expect(file.bytes).toBe(Buffer.byteLength('中文 😀'));
 expect(()=>browserDownload(root,'link.txt')).toThrow();expect(browserFilename.safeParse('../private').success).toBe(false);
});
it('retains selected bytes for later form submission and removes failed uploads',async()=>{
 const root=fixture();let uploaded='';
 await browserUpload(root,'sample.txt',Readable.from([Buffer.from('上传 😀')]),async path=>{uploaded=path;expect(readFileSync(path,'utf8')).toBe('上传 😀')});
 expect(readFileSync(uploaded,'utf8')).toBe('上传 😀');expect(readdirSync(join(root,'uploads'))).toHaveLength(1);
 await expect(browserUpload(root,'sample.txt',Readable.from([Buffer.from('x')]),async()=>{throw Error('Control changed')})).rejects.toThrow('Control changed');
 expect(readdirSync(join(root,'uploads'))).toHaveLength(1);
});
