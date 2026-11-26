import {expect,it} from 'vitest'
import {parseHunks,splitWorkerPatch} from '../src/worker-patch.ts'

it('retains all hunks and no-newline markers independently of the short chat excerpt',()=>{
 const raw=['diff --git a/file.ts b/file.ts','--- a/file.ts','+++ b/file.ts','@@ -1,0 +1,18 @@',
  ...Array.from({length:18},(_,i)=>'+'+i),'@@ -99 +117 @@','-old','+new','\\ No newline at end of file',''].join('\n')
 const [patch]=splitWorkerPatch(raw)
 expect(patch!.raw).toBe(raw)
 expect(patch!.file).toMatchObject({path:'file.ts',added:19,removed:1})
 expect(patch!.file.hunks[0]!.lines).toHaveLength(7)
 expect(parseHunks(raw)[1]).toMatchObject({oldStart:99,newStart:117,lines:['-old','+new','\\ No newline at end of file']})
})
it('reads quoted UTF-8 paths, binary and empty-file changes without guessing from extensions',()=>{
 const binary='diff --git "a/\\346\\226\\207.bin" "b/\\346\\226\\207.bin"\nBinary files differ\n'
 const empty='diff --git a/empty file b/empty file\nnew file mode 100644\n'
 const patches=splitWorkerPatch(binary+empty)
 expect(patches.map(p=>[p.file.path,p.file.binary,p.raw])).toEqual([['文.bin',true,binary],['empty file',false,empty]])
})
