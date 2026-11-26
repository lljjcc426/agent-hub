// Recognize direct test commands. Log parsers below report what the runner
// printed; the host process exit code is the authoritative outcome.
export function isTestCommand(command:string){
 // Skip only ordinary leading shell setup. A script that prints a test command is still ordinary output.
 const setup=/^\s*(?:set\s+-[a-z]+|cd\s+(?:[\w./-]+|"[^"\n]+"|'[^'\n]+')|export\s+\w+=(?:"[^"\n]*"|'[^'\n]*'|[^\s;&]+))\s*(?:&&|;|\n)\s*/i
 let executable=command.trimStart()
 while(setup.test(executable))executable=executable.replace(setup,'')
 executable=executable.replace(/^\{\s+/,'')
 return /^(?:pytest|python(?:3(?:\.\d+)?)?\s+-m\s+(?:pytest|unittest)|node\s+--test|(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test(?::[\w-]+)?|check))|(?:(?:npx\s+|(?:\.\/)?node_modules\/\.bin\/))?vitest)(?=\s|$)/.test(executable)
}

export function reportedTestCounts(tail:string){
 const pytest=/^(?:=+[ \t]*)?((?:\d+ (?:passed|failed|skipped|errors?)(?:, )?)+) in \d+(?:\.\d+)?s(?:[ \t]*=+)?\r?$/m
 const vitest=/^[ \t]*Tests[ \t]+((?:\d+ (?:passed|failed|skipped|todo)[ \t]*(?:\|[ \t]*)?)+)(?:\(\d+\))?[ \t]*\r?$/m
 const summary=pytest.exec(tail)?.[1]??vitest.exec(tail)?.[1]
 if(summary)return Object.fromEntries([...summary.matchAll(/(\d+) (passed|failed|skipped|errors?|todo)/g)].map(
  ([,count,label])=>[label==='error'?'errors':label,Number(count)],
 ))
 const unittest=/^Ran (\d+) tests? in \d+(?:\.\d+)?s\r?\n\r?\n(?:OK|FAILED)(?: \(([^)]+)\))?\r?$/m.exec(tail)
 if(unittest){
  const counts=Object.fromEntries([...(unittest[2]??'').matchAll(/(failures|errors|skipped|expected failures|unexpected successes)=(\d+)/g)].map(
   ([,name,count])=>[name,Number(count)],
  ))
  return {total:Number(unittest[1]),...counts}
 }
 const tap=Object.fromEntries([...tail.matchAll(/^# (tests|pass|fail|skipped|todo) (\d+)\r?$/gm)].map(
  ([,label,count])=>[label==='tests'?'total':label==='pass'?'passed':label==='fail'?'failed':label,Number(count)],
 ))
 if(tap.total!==undefined&&tap.passed!==undefined&&tap.failed!==undefined)return tap
}
