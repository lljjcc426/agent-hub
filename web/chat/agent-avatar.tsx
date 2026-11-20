import {createContext,useContext} from 'react';
import type {RoppoAppearance} from '../../src/chat-personalization.ts';
import router from '../../src/ui/assets/agents/router.webp';
import sage from '../../src/ui/assets/agents/worker-sage.webp';
import blue from '../../src/ui/assets/agents/worker-blue.webp';
import clay from '../../src/ui/assets/agents/worker-clay.webp';
import stone from '../../src/ui/assets/agents/worker-stone.webp';
import './agent-avatar.css';

export const teamName = (label: string) => (label.replace(/(?:^Router$| · Router$)/, '').trim() || 'Roppo')

const workers = [sage, blue, clay, stone];
const appearances = {classic:router, sage, blue};
export const RoppoAppearanceContext = createContext<RoppoAppearance>('classic');
export const roppoSkin = {classic:undefined,sage:0,blue:1} as const;

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
  const appearance = useContext(RoppoAppearanceContext);
  return <img className="agent-portrait" data-agent-id={id} data-kind={kind}
    data-appearance={kind === 'router' ? appearance : undefined}
    src={kind === 'router' ? appearances[appearance] : workers[workerColorIndex(id)]} alt="" aria-hidden="true"
    width={size} height={size} draggable={false} />;
}
