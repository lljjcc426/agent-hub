import { randomBytes } from 'node:crypto'
import { AccountError } from '../personal-account.ts'

interface Pair {
  secret: string
  expires: number
  token?: string
}
export class TerminalPairing {
  private pairs = new Map<string, Pair>()
  constructor(private now = Date.now) {}
  start() {
    for (const [id, pair] of this.pairs) if (pair.expires <= this.now()) this.pairs.delete(id)
    if (this.pairs.size >= 32) throw new AccountError('pair_busy', 'Too many pending sign-ins.', 429)
    const id = randomBytes(16).toString('hex'),
      secret = randomBytes(32).toString('hex')
    this.pairs.set(id, { secret, expires: this.now() + 180_000 })
    return { id, secret }
  }
  private get(id: string) {
    const pair = this.pairs.get(id)
    if (!pair || pair.expires <= this.now())
      throw new AccountError('pair_expired', 'Start a new terminal sign-in.', 410)
    return pair
  }
  approve(id: string, issue: () => string) {
    const pair = this.get(id)
    pair.token ??= issue()
  }
  claim(id: string, secret: string) {
    const pair = this.get(id)
    if (pair.secret !== secret) throw new AccountError('pair_invalid', 'Invalid sign-in request.', 403)
    if (pair.token) this.pairs.delete(id)
    return { token: pair.token }
  }
}

export const pairingPage = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Roppo CLI</title>
<style>body{font:16px system-ui;max-width:30rem;margin:15vh auto;padding:24px;color:#222}code{font-size:1.3rem}button,a{font:inherit;padding:10px 16px}button{background:#222;color:white;border:0;border-radius:7px}p{line-height:1.5}</style>
<h1>Connect Roppo CLI</h1><p>Match this code with the one in your terminal.</p><p><code></code></p><button>Connect terminal</button><a href="/auth" target="_blank" rel="noopener">Sign in</a><p role="status"></p>
<script>const id=location.hash.slice(1),button=document.querySelector('button'),status=document.querySelector('[role=status]');
document.querySelector('code').textContent=id.slice(-8).toUpperCase();button.disabled=!/^[a-f0-9]{32}$/.test(id);
button.onclick=async()=>{button.disabled=true;try{const response=await fetch('/api/terminal/pair/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id})});if(!response.ok)throw Error(response.status===401?'Sign in, then return here to connect.':'Sign-in expired. Run roppo login again.');status.textContent='Connected. Return to your terminal.'}catch(error){status.textContent=error.message;button.disabled=false}};</script></html>`
