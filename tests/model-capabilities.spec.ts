import {afterEach, expect, it, vi} from 'vitest'
import {apiOptions, reasoningOverride} from '../src/agent-options.ts'
import {apiBackendDefinition, type ApiDefinition} from '../src/backend-config.ts'
import {configSchema} from '../src/config.ts'
import {catalogReasoning, ModelCapabilityCatalog, openAiReasoningSpec} from '../src/model-capabilities.ts'
import type {Runtime} from '../src/runtime.ts'

afterEach(() => vi.unstubAllGlobals())

function host(backends: Record<string, unknown>, native?: unknown) {
  return {
    config: configSchema.parse({backends,sources:[{id:'local',kind:'local',cwd:'.',allowedActors:['operator']}]}),
    model: {catalog: async () => native},
  } as Runtime
}

it('reads native, DeepSeek and Claude levels and distinguishes missing metadata from explicit lack of support', () => {
  expect(catalogReasoning({supportedReasoningEfforts: [
    {reasoningEffort: 'low'}, {reasoningEffort: 'ultra'}, {reasoningEffort: 'private'},
  ], defaultReasoningEffort: 'low'})).toEqual({efforts: ['low','ultra'], defaultEffort: 'low', source: 'catalog'})
  expect(catalogReasoning({effort: {supported_levels: ['low','high','max'], default_level: 'high'}}))
    .toEqual({efforts: ['low','high','max'], defaultEffort: 'high', source: 'catalog'})
  expect(catalogReasoning({capabilities: {effort: {supported: true, low: {supported: true}, max: {supported: false}}}}))
    .toEqual({efforts: ['low'], source: 'catalog'})
  expect(catalogReasoning({capabilities: {effort: {supported: false}}})).toEqual({efforts: [], source: 'catalog'})
  expect(catalogReasoning({supported_parameters: ['reasoning_effort']})).toBeUndefined()
})

it('uses one authenticated catalog per connection and selects by exact model', async () => {
  const config = {kind:'openai-chat', model:'first', headers:{'X-Project':'fixture'}}
  const runtime = host({one:{...config, baseUrl:'https://one.example/v1'}, two:{...config, baseUrl:'https://two.example/v1'}})
  const fetchCatalog = vi.fn(async (url: string) => Response.json({data: [
    {id:'first', supported_reasoning_efforts: url.includes('one.example') ? ['low','max'] : ['medium']},
    {id:'second', supported_reasoning_efforts: ['none']},
    {id:'third'},
    {id:'hidden', hidden:true},
  ]}))
  vi.stubGlobal('fetch', fetchCatalog)
  const service = new ModelCapabilityCatalog()
  const [first, second, third, other] = await Promise.all([
    service.read(runtime,'one','first'), service.read(runtime,'one','second'),
    service.read(runtime,'one','third'), service.read(runtime,'two','first'),
  ])
  expect(fetchCatalog).toHaveBeenCalledTimes(2)
  expect(fetchCatalog).toHaveBeenCalledWith('https://one.example/v1/models', expect.objectContaining({
    headers: expect.objectContaining({'X-Project':'fixture'}), redirect:'error',
  }))
  expect(first).toMatchObject({model:'first',models:['first','second','third'],reasoning:{efforts:['low','max']}})
  expect(second.reasoning.efforts).toEqual(['none'])
  expect(third.reasoning).toEqual({efforts:[],source:'unknown'})
  expect(other.reasoning.efforts).toEqual(['medium'])
})

it('uses the default model advertised by Codex when no model was configured', async () => {
  const runtime = host({}, {data:[
    {id:'alpha', supportedReasoningEfforts:[{reasoningEffort:'low'}]},
    {id:'native-default', isDefault:true, supportedReasoningEfforts:[{reasoningEffort:'ultra'}]},
  ]})
  runtime.config.model = undefined
  await expect(new ModelCapabilityCatalog().read(runtime,'codex')).resolves.toMatchObject({
    model:'native-default', reasoning:{efforts:['ultra'],source:'catalog'},
  })
})

it('falls back only for the official endpoint and respects an explicit empty catalog declaration', async () => {
  const config = {kind:'openai-responses',model:'gpt-6.1-terra'}
  const runtime = host({
    direct:{...config,baseUrl:'https://api.openai.com/v1'},
    proxy:{...config,baseUrl:'https://compat.example/v1'},
  })
  const fetchCatalog = vi.fn(async () => Response.json({data:[
    {id:'gpt-6.1-terra'},
    {id:'gpt-5.4', supported_reasoning_efforts:[]},
  ]}))
  vi.stubGlobal('fetch', fetchCatalog)
  const service = new ModelCapabilityCatalog()
  await expect(service.read(runtime,'direct')).resolves.toMatchObject({
    reasoning:{efforts:['none','low','medium','high','xhigh','max'],source:'official'},
  })
  await expect(service.read(runtime,'proxy')).resolves.toMatchObject({reasoning:{efforts:[],source:'unknown'}})
  await expect(service.read(runtime,'direct','gpt-5.4')).resolves.toMatchObject({reasoning:{efforts:[],source:'catalog'}})
  expect(fetchCatalog).toHaveBeenCalledTimes(2)
})

it('reads an official Markdown declaration for the exact model and checks Chat Completions compatibility', () => {
  const docs = 'Model ID: `sample-model`\n\nReasoning.effort supports: none (default), low, medium, high and xhigh.\n\nSupported endpoints: responses'
  expect(openAiReasoningSpec(docs,'sample-model')).toEqual({efforts:['none','low','medium','high','xhigh'],defaultEffort:'none',source:'official'})
  expect(openAiReasoningSpec(docs,'sample-model',true)).toBeUndefined()
  expect(openAiReasoningSpec(docs.replace('endpoints: responses','endpoints: responses, chat_completions'),'sample-model',true))
    .toMatchObject({defaultEffort:'none'})
  expect(openAiReasoningSpec(docs,'another-model')).toBeUndefined()
})

it.each([
  ['openai-chat', {reasoning_effort:'high'}, {}],
  ['openai-responses', {reasoning:{effort:'high',summary:'auto'}}, {reasoning:{summary:'auto'}}],
  ['anthropic', {output_config:{effort:'high'}}, {}],
] as const)('omits an inherited %s effort when following the model default', (kind, parameter, remaining) => {
  const definition: ApiDefinition = apiBackendDefinition.parse({kind,baseUrl:'https://fixture.example/v1',model:'sample',parameters:parameter})
  expect(apiOptions(definition,{effort:null}).parameters).toEqual(remaining)
  const override = reasoningOverride(kind,{},'max')
  expect(apiOptions(definition,override).parameters).toMatchObject(override.parameters!)
  expect(apiOptions(definition,{}).parameters).toEqual(parameter)
})
