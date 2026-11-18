import router from '../../src/ui/assets/agents/router.webp';
import sage from '../../src/ui/assets/agents/worker-sage.webp';
import blue from '../../src/ui/assets/agents/worker-blue.webp';
import clay from '../../src/ui/assets/agents/worker-clay.webp';
import stone from '../../src/ui/assets/agents/worker-stone.webp';
import './agent-avatar.css';

export const teamName = (label: string) => (label.replace(/(?:^Router$| · Router$)/, '').trim() || 'Roppo')

const workers = [sage, blue, clay, stone];

// Identity, not display order or current task, determines a Worker's appearance.
export function workerColorIndex(id: string) {
  let hash = 0;
  for (const char of id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return hash % workers.length;
}

export function AgentAvatar({id = 'router', kind = 'router', size = 32}: {
  id?: string;
  kind?: 'router' | 'worker';
  size?: number;
}) {
  return <img className="agent-portrait" data-agent-id={id} data-kind={kind}
    src={kind === 'router' ? router : workers[workerColorIndex(id)]} alt="" aria-hidden="true"
    width={size} height={size} draggable={false} />;
}
