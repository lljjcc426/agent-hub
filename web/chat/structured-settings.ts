import type { ApiDefinition, WorkerProfile } from '../../src/backend-config.ts';
import type { Config } from '../../src/config.ts';
import type { DecisionConfig } from '../../src/decision-config.ts';
import type { DecisionRecord } from '../../src/decision.ts';
import type { LoadModelCapabilities } from './model-capabilities.ts';

export type SettingsLabels = (en: string, zh: string) => string;
export type RouterMode = NonNullable<NonNullable<Config['execution']['router']>['mode']>;
export type AgentEffort = NonNullable<WorkerProfile['effort']>;
export type WorkerState = NonNullable<WorkerProfile['state']>;
export type SettingsMember = {
  id: string;
  kind: 'router' | 'worker';
  name: string;
  label?: string;
  backend: string;
  model?: string;
  displayModel?: string;
  state?: WorkerState;
  effort?: AgentEffort | null;
  timeoutMs?: number;
  browserAccess?: boolean;
};
export type ModelConnection = {
  id: string;
  label: string;
  model?: string;
  kind: string;
  decisionEligible: boolean;
};

type StoredProvider = NonNullable<DecisionConfig['provider']>;
type ApiProviderDraft = Partial<ApiDefinition> & Pick<ApiDefinition, 'kind' | 'baseUrl' | 'model'>;
export type DecisionProviderDraft = Exclude<StoredProvider, ApiDefinition> | ApiProviderDraft;
export type DecisionDraft = Omit<DecisionConfig, 'provider'> & { provider?: DecisionProviderDraft };
export type SettingsProblem = { path: string; labels: [en: string, zh: string] };
export type DecisionResult = Pick<DecisionRecord, 'status' | 'code' | 'decisions' | 'latencyMs' | 'usage'>;
export type MemberEdit = {
  label?: string;
  backend?: string;
  model?: string;
  state?: WorkerState;
};

export interface StructuredSettings {
  scope: number;
  revision: number;
  router: SettingsMember;
  workers: SettingsMember[];
  connections: ModelConnection[];
  defaultWorkerBackend: string;
  workerLimit: number;
  routerManagesWorkers: boolean;
  routerMode: RouterMode;
  canEditTeam: boolean;
  canEditDecision: boolean;
  canProbe: boolean;
  decision: DecisionDraft;
  savedDecision: DecisionDraft;
  decisionCalls: DecisionRecord[];
  problems: Record<string, string>;
  buffers: Record<string, string>;
  editMember: (id: string | null, edit: MemberEdit) => boolean;
  addWorker: (edit: Required<Pick<MemberEdit, 'label' | 'backend'>> & MemberEdit, copy?: string) => string | false;
  removeWorker: (id: string) => boolean;
  setRouterMode: (mode: RouterMode) => void;
  setWorkerLimit: (value?: string) => void;
  setRouterManagesWorkers: (enabled: boolean) => void;
  loadModelCapabilities: LoadModelCapabilities;
  setEffort: (id: string | null, value: AgentEffort | null) => void;
  setTimeout: (id: string | null, minutes?: string) => void;
  setBrowserAccess: (id: string, allowed?: boolean) => void;
  setDecision: (value: DecisionDraft, problem?: SettingsProblem) => void;
  probeDecision: (text: string) => Promise<DecisionResult>;
}
