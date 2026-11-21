import {afterEach, expect, it, vi} from 'vitest'
import {apiModelCatalog, selectableModelIds} from '../src/backends/model-catalog.ts'
import {catalogReasoning} from '../src/model-capabilities.ts'

afterEach(() => vi.unstubAllGlobals())

it.each([
  ['openai-responses','https://api.openai.com/v1','https://api.openai.com/v1/models','authorization','Bearer fixture-key'],
  ['openai-chat','https://api.deepseek.com','https://api.deepseek.com/models','authorization','Bearer fixture-key'],
  ['anthropic','https://api.deepseek.com/anthropic','https://api.deepseek.com/models','authorization','Bearer fixture-key'],
  ['anthropic','https://api.anthropic.com/v1','https://api.anthropic.com/v1/models?limit=1000','x-api-key','fixture-key'],
  ['openai-chat','https://generativelanguage.googleapis.com/v1beta/openai/','https://generativelanguage.googleapis.com/v1beta/openai/models','authorization','Bearer fixture-key'],
  ['openai-chat','https://api.moonshot.cn/v1','https://api.moonshot.cn/v1/models','authorization','Bearer fixture-key'],
  ['openai-chat','https://api.groq.com/openai/v1','https://api.groq.com/openai/v1/models','authorization','Bearer fixture-key'],
  ['openai-chat','https://openrouter.ai/api/v1','https://openrouter.ai/api/v1/models/user','authorization','Bearer fixture-key'],
  ['openai-chat','https://api.x.ai/v1','https://api.x.ai/v1/language-models','authorization','Bearer fixture-key'],
] as const)('reads %s models from the documented catalog on %s', async (kind, baseUrl, url, header, value) => {
  const rows=[{id:'test-text'}], fetchModelList=vi.fn(async () => Response.json({data:rows}))
  vi.stubGlobal('fetch',fetchModelList)
  await expect(apiModelCatalog({kind,baseUrl},'fixture-key')).resolves.toEqual(rows)
  expect(fetchModelList).toHaveBeenCalledExactlyOnceWith(url,expect.objectContaining({
    headers:expect.objectContaining({[header]:value,...(url.includes('api.anthropic.com')?{'anthropic-version':'2023-06-01'}:{})}),
    redirect:'error',
  }))
})

it('reads text-generation pages from the Bailian workspace for the same credential', async () => {
  const base='https://workspace.cn-beijing.maas.aliyuncs.com'
  const fetchModelList=vi.fn(async (input:string) => {
    const request=new URL(input), page=Number(request.searchParams.get('page_no'))
    expect(request.origin).toBe(base)
    expect(request.pathname).toBe('/api/v1/models')
    expect(request.searchParams.get('capabilities')).toBe('TG')
    const inference_metadata={request_modality:['Text','Image'],response_modality:['Text']}
    return Response.json({output:{models:[{model:'qwen-fixture-'+page,inference_metadata}],total:101,page_size:100}})
  })
  vi.stubGlobal('fetch',fetchModelList)
  const endpoint={kind:'anthropic',baseUrl:base+'/apps/anthropic'} as const
  expect(selectableModelIds(await apiModelCatalog(endpoint,'fixture-key'),endpoint)).toEqual(['qwen-fixture-1','qwen-fixture-2'])
  expect(fetchModelList).toHaveBeenCalledTimes(2)
  expect(fetchModelList).toHaveBeenCalledWith(expect.stringContaining('page_no=2'),expect.objectContaining({
    headers:expect.objectContaining({authorization:'Bearer fixture-key'}),
  }))
})

it('filters models that are known to be incompatible and retains unclassified custom models', () => {
  const rows=[
    {id:'work'}, {id:'work'}, {id:'quiet',hidden:true}, {id:'inactive',active:false},
    {id:'imagine',architecture:{input_modalities:['text'],output_modalities:['image']}},
    {id:'embed',capabilities:{completion_chat:false}},
    {id:'audio',input_modalities:['audio']},
    {id:'responses-only',supported_endpoints:['responses']},
    {id:'gpt-image-fixture'}, {id:'text-embedding-fixture'}, {id:'whisper-fixture'},
  ]
  expect(selectableModelIds(rows,{kind:'openai-chat',baseUrl:'https://api.openai.com/v1'})).toEqual(['work'])
  expect(selectableModelIds(rows,{kind:'openai-chat',baseUrl:'https://custom.example/v1'})).toEqual([
    'work','gpt-image-fixture','text-embedding-fixture','whisper-fixture',
  ])
  expect(catalogReasoning({capabilities:{reasoning_effort:['low','high'],default_reasoning_effort:'high'}}))
    .toEqual({source:'catalog',efforts:['low','high'],defaultEffort:'high'})
})
