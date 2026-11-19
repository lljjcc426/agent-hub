import { useId, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Button, ChoiceGroup, DisclosureRoot, DisclosureSummary, InputControl, SelectField, TextAreaField } from '../ui';
import type { DecisionDraft, DecisionProviderDraft, DecisionResult, SettingsLabels, SettingsProblem, StructuredSettings } from './structured-settings.ts';

type Method = 'rules' | 'jev' | 'local' | 'external';
type Endpoint = Exclude<DecisionProviderDraft, { kind: 'backend' }>;
type ApiEndpoint = Exclude<Endpoint, { kind: 'jev' }>;
type EndpointField = 'baseUrl' | 'model' | 'apiKeyEnv';

function loopback(address: string) {
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(address).hostname); }
  catch { return false; }
}
function providerMethod(provider?: DecisionProviderDraft): Exclude<Method, 'rules'> {
  if (provider?.kind === 'jev') return 'jev';
  return provider && provider.kind !== 'backend' && loopback(provider.baseUrl) ? 'local' : 'external';
}
function proposal(method: Exclude<Method, 'rules'>): DecisionProviderDraft {
  if (method === 'jev') return { kind: 'jev', baseUrl: 'https://api.typesafe.ai/v1', model: 'jev-latest', apiKeyEnv: 'TYPESAFE_API_KEY' };
  if (method === 'local') return { kind: 'openai-chat', baseUrl: 'http://127.0.0.1:8080/v1', model: '' };
  return { kind: 'backend', id: '' };
}
function decisionProblem(value: DecisionDraft, settings: StructuredSettings): SettingsProblem | undefined {
  const provider = value.provider;
  if (value.mode === 'off') return;
  if (!provider) return { path: 'decision.provider', labels: ['Choose a model connection.', '请选择模型连接。'] };
  if (provider.kind === 'backend') {
    if (!settings.connections.some(connection => connection.id === provider.id && connection.decisionEligible)) return {
      path: 'decision.provider.id', labels: ['Choose a connection or enter a service address.', '请选择已有连接，或手动填写服务地址。'],
    };
    return;
  }
  let url: URL | undefined;
  try { url = new URL(provider.baseUrl); } catch {}
  if (!url || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(provider.baseUrl))) ||
    url.username || url.password || url.search || url.hash) return {
    path: 'decision.provider.baseUrl', labels: ['Use HTTPS, or HTTP for a service on this machine.', '请输入 HTTPS 地址，本机服务可用 HTTP。'],
  };
  if (!provider.model.trim()) return { path: 'decision.provider.model', labels: ['Enter a model name.', '请填写模型名称。'] };
  if (provider.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(provider.apiKeyEnv)) return {
    path: 'decision.provider.apiKeyEnv', labels: ['Enter a variable name, such as MODEL_API_KEY.', '请填写密钥变量名，例如 MODEL_API_KEY。'],
  };
}

function EndpointFields({ prefix, provider, fields, problems, disabled, onChange, L }: {
  prefix: string; provider: Endpoint; fields: EndpointField[]; problems: StructuredSettings['problems']; disabled: boolean;
  onChange: (field: EndpointField, value: string) => void; L: SettingsLabels;
}) {
  const labels: Record<EndpointField, string> = {
    baseUrl: L('Service address', '服务地址'), model: L('Model name', '模型名称'), apiKeyEnv: L('Key variable name', '密钥变量名'),
  };
  return fields.map(field => {
    const id = prefix + '-' + field, error = problems['decision.provider.' + field];
    return (
      <div className="run-config-row" key={field}>
        <label htmlFor={id}>{labels[field]}</label>
        <div>
          <InputControl id={id} value={provider[field] ?? ''} disabled={disabled} type={field === 'baseUrl' ? 'url' : 'text'}
            autoComplete="off" autoCapitalize="none" spellCheck={false} aria-invalid={!!error || undefined}
            aria-describedby={error ? id + '-error' : undefined}
            placeholder={field === 'apiKeyEnv' ? L('Optional, e.g. MODEL_API_KEY', '选填，例如 MODEL_API_KEY') : undefined}
            onChange={event => onChange(field, event.target.value)} />
          {error && <p id={id + '-error'} className="run-config-error" role="alert">{error}</p>}
        </div>
      </div>
    );
  });
}

export function DecisionConfiguration({ settings, blocked, L }: {
  settings: StructuredSettings; blocked: boolean; L: SettingsLabels;
}) {
  const prefix = useId();
  const value = settings.decision;
  const provider = value.provider;
  const [picked, setPicked] = useState<{ value: DecisionDraft; method: Method }>();
  const [sample, setSample] = useState('');
  const [probe, setProbe] = useState<{ key: string; pending?: boolean; result?: DecisionResult; error?: string }>();
  const cache = useRef<{ revision: number; choices: Partial<Record<Method, DecisionDraft>>; manual?: ApiEndpoint }>({
    revision: settings.revision, choices: {},
  });
  if (cache.current.revision !== settings.revision) cache.current = { revision: settings.revision, choices: {} };
  const method = picked?.value === value ? picked.method : value.mode === 'off' ? 'rules' : providerMethod(provider);
  const disabled = blocked || !settings.canEditDecision;
  const probeKey = JSON.stringify([settings.revision, value, sample]);
  const shownProbe = probe?.key === probeKey ? probe : undefined;
  const connectionError = settings.problems['decision.provider.id'];
  const externalValue = provider?.kind === 'backend' ? provider.id : ':manual';

  function change(next: DecisionDraft, nextMethod: Method) {
    setPicked({ value: next, method: nextMethod });
    settings.setDecision(next, decisionProblem(next, settings));
  }
  function changeProvider(nextProvider: DecisionProviderDraft, selected: Exclude<Method, 'rules'>) {
    const nextMode = value.mode === 'off' ? 'shadow' : value.mode;
    const next = { ...value, mode: nextMode, provider: nextProvider };
    // Different protocols do not necessarily support the same overrides.
    if (next.provider.kind === 'jev') next.parameters = {};
    if (next.provider.kind === 'jev' || next.provider.kind === 'anthropic' ||
      nextProvider.kind === 'backend' && settings.connections.find(connection => connection.id === nextProvider.id)?.kind === 'anthropic')
      delete next.effort;
    change(next, selected);
  }
  function selectMethod(selected: Method) {
    if (selected === method) return;
    if (method !== 'rules' && provider) cache.current.choices[method] = value;
    if (selected === 'rules') {
      const valid = decisionProblem(value, settings) ? settings.savedDecision : value;
      change({ ...valid, mode: 'off' }, selected);
      return;
    }
    const remembered = cache.current.choices[selected];
    if (remembered) {
      change({ ...value, provider: remembered.provider, mode: value.mode === 'off' ? remembered.mode : value.mode,
        effort: remembered.effort, parameters: remembered.parameters }, selected);
      return;
    }
    const saved = method === 'rules' && provider && providerMethod(provider) === selected ? provider : undefined;
    changeProvider(saved ?? proposal(selected), selected);
  }
  function changeConnection(id: string) {
    if (provider?.kind !== 'backend' && provider?.kind !== 'jev') cache.current.manual = provider;
    changeProvider(id === ':manual' ? cache.current.manual ?? { kind: 'openai-chat', baseUrl: '', model: '' } : { kind: 'backend', id }, 'external');
  }
  function editEndpoint(field: EndpointField, entry: string) {
    if (!provider || provider.kind === 'backend') return;
    const next = { ...provider, [field]: entry };
    if (field === 'apiKeyEnv' && !entry) delete next.apiKeyEnv;
    change({ ...value, provider: next }, method);
  }
  async function runProbe() {
    if (probe?.pending || !settings.canProbe || !sample.trim()) return;
    setProbe({ key: probeKey, pending: true });
    try {
      const result = await settings.probeDecision(sample.trim());
      setProbe({ key: probeKey, result });
    } catch (error) {
      setProbe({ key: probeKey, error: error instanceof Error ? error.message : L('Test failed.', '判断测试失败。') });
    }
  }
  const result = shownProbe?.result;
  const endpointProps = provider && provider.kind !== 'backend'
    ? { prefix, provider, problems: settings.problems, disabled, onChange: editEndpoint, L } : undefined;
  const methodFields: EndpointField[] = ['baseUrl', 'model', 'apiKeyEnv'];
  const outcomes: Record<string, string> = {
    STOP: L('Stop', '停止'), CONTINUE: L('Continue', '续接'), IGNORE: L('Ignore', '忽略'),
    INTERVENE: L('Intervene', '介入'), REVIEW: L('Review', '复核'),
  };
  return (
    <section className="settings-group run-config-section-action" aria-labelledby={prefix + '-heading'}>
      <h2 id={prefix + '-heading'}>{L('Message intent', '消息前置判断')}</h2>
      <a className="run-config-rules-link" href="/configure#advanced/intake">
        {L('Follow-up rules', '跟进规则')}<ChevronRight size={15} aria-hidden="true" />
      </a>
      <div className="run-config-panel">
        <div className="run-config-row">
          <div className="run-config-label">
            <span>{L('Judgment method', '判断方式')}</span>
            {method === 'rules' && <p>{L('Router applies your follow-up rules.', '由 Router 按跟进规则判断。')}</p>}
          </div>
          <ChoiceGroup label={L('Judgment method', '判断方式')} value={method} onChange={selectMethod}
            choices={[
              { value: 'rules', label: L('Rules', '规则'), disabled },
              { value: 'jev', label: 'Jev', disabled },
              { value: 'local', label: L('Local', '本地'), disabled },
              { value: 'external', label: L('External', '外接'), disabled },
            ]} />
        </div>
        {method !== 'rules' && <div className="run-config-decision-options" key={method}>
          {settings.routerMode !== 'host' && <p className="run-config-decision-note">
            {L('The model runs when Router uses continuous coordination.', 'Router 采用「持续协作」时，前置模型才会运行。')}
          </p>}
          {method === 'jev' && endpointProps && <>
            <EndpointFields {...endpointProps} fields={['apiKeyEnv']} />
            <DisclosureRoot className="run-config-decision-details" open={settings.problems['decision.provider.baseUrl'] ||
              settings.problems['decision.provider.model'] ? true : undefined}>
              <DisclosureSummary indicator>{L('Service address and model', '服务地址和模型')}</DisclosureSummary>
              <EndpointFields {...endpointProps} fields={['baseUrl', 'model']} />
            </DisclosureRoot>
          </>}
          {method === 'local' && endpointProps && <EndpointFields {...endpointProps} fields={methodFields} />}
          {method === 'external' && <>
            <div className="run-config-row">
              <label htmlFor={prefix + '-connection'}>{L('Model connection', '模型连接')}</label>
              <div>
                <SelectField id={prefix + '-connection'} value={externalValue} disabled={disabled}
                  aria-invalid={!!connectionError || undefined} aria-describedby={connectionError ? prefix + '-connection-error' : undefined}
                  onChange={event => changeConnection(event.target.value)}>
                  <option value="">{L('Choose a connection', '选择连接')}</option>
                  {settings.connections.filter(connection => connection.decisionEligible).map(connection =>
                    <option key={connection.id} value={connection.id}>{connection.label}</option>)}
                  <option value=":manual">{L('Enter a service address', '手动填写服务地址')}</option>
                </SelectField>
                {connectionError && <p id={prefix + '-connection-error'} className="run-config-error" role="alert">{connectionError}</p>}
              </div>
            </div>
            {endpointProps && provider && provider.kind !== 'backend' && provider.kind !== 'jev' && <>
              <div className="run-config-row">
                <label htmlFor={prefix + '-protocol'}>{L('API type', '接口类型')}</label>
                <SelectField id={prefix + '-protocol'} value={provider.kind} disabled={disabled} onChange={event => {
                  const kind = event.target.value as ApiEndpoint['kind'];
                  // Provider-specific request parameters belong to their protocol.
                  const { baseUrl, model, apiKeyEnv, headers, headerEnv } = provider;
                  changeProvider({ kind, baseUrl, model, apiKeyEnv, headers, headerEnv }, 'external');
                }}>
                  <option value="openai-chat">OpenAI Chat</option>
                  <option value="openai-responses">OpenAI Responses</option>
                  <option value="anthropic">Anthropic Messages</option>
                </SelectField>
              </div>
              <EndpointFields {...endpointProps} fields={methodFields} />
            </>}
          </>}
          <div className="run-config-row">
            <span>{L('Use results', '如何使用判断结果')}</span>
            <ChoiceGroup label={L('Use results', '如何使用判断结果')} value={value.mode}
              choices={[
                { value: 'shadow', label: L('Record only', '只记录判断'), disabled },
                { value: 'advisory', label: L('Advise Router', '给 Router 建议'), disabled },
              ]} onChange={mode => change({ ...value, mode }, method)} />
          </div>
          <DisclosureRoot className="run-config-decision-details">
            <DisclosureSummary indicator>{L('Try a message', '试一条消息')}</DisclosureSummary>
            <div className="run-config-probe">
              <TextAreaField label={L('Test message', '测试消息')} rows={3} value={sample} maxLength={4000}
                placeholder={L('For example, “please continue with the previous task”', '例如「继续处理刚才那个任务」')}
                onChange={event => setSample(event.target.value)} />
              <div className="run-config-probe-actions">
                <Button disabled={!settings.canProbe || !value.provider || !sample.trim()} busy={probe?.pending}
                  onClick={() => void runProbe()}>{L('Run test', '运行测试')}</Button>
                <div role="status">
                  {shownProbe?.error ?? (result?.status === 'ok'
                    ? [...(result.decisions ?? []).map(decision => outcomes[decision.action] ?? decision.action), result.latencyMs + ' ms',
                      result.usage?.inputTokens === undefined ? '' : L('Input ', '输入 ') + result.usage.inputTokens,
                      result.usage?.outputTokens === undefined ? '' : L('Output ', '输出 ') + result.usage.outputTokens].filter(Boolean).join(' · ')
                    : result ? L('Test unavailable', '测试未能完成') + (result.code ? ' · ' + result.code : '') : '')}
                </div>
              </div>
            </div>
          </DisclosureRoot>
        </div>}
        {settings.decisionCalls.length > 0 && <DisclosureRoot className="run-config-decision-details">
          <DisclosureSummary indicator>{L('Recent judgments', '最近判断')}</DisclosureSummary>
          <ul className="run-config-decision-calls">{settings.decisionCalls.slice(0, 10).map(call => (
            <li key={call.id}>
              <time dateTime={new Date(call.at).toISOString()}>{new Date(call.at).toLocaleString(L('en', 'zh-CN'))}</time>
              <span>{call.code || call.decisions?.map(decision => outcomes[decision.action]).join('、') || call.status}</span>
              <span>{call.latencyMs} ms</span>
            </li>
          ))}</ul>
        </DisclosureRoot>}
      </div>
    </section>
  );
}
