import type {ChatPreferences} from '../../src/chat-personalization.ts'
import type {Localize} from './composer-commands.tsx'

export function chatPersonalizationCopy(L:Localize) {
  return {
    purposes: {
      general: {label:L('A bit of everything','都想试试'),starter:L('Sort my priorities','整理待办'),prompt:L('Help me sort out what to do today.','帮我排一下今天的待办。'),point:L('Start with what is due today, then group the remaining items by effort.','先挑出今天到期的事，再按各自需要的时间分组。'),detail:L('Put the shortest useful action first so it is easy to get started.','把一件容易起步的小事放在最前面。')},
      writing: {label:L('Writing','写作'),starter:L('Draft a project update','起草进度简报'),prompt:L('Help me turn these project notes into a short update.','帮我把项目记录整理成一份简短的进度报告。'),point:L('Cover what moved forward, what is blocked, and what is next.','按已推进的事项、遇到的阻碍和下一步来整理。'),detail:L('Keep dates and owners from the notes, and flag any gaps for review.','保留记录里的日期和负责人，缺的信息单独标出来。')},
      research: {label:L('Research','学习研究'),starter:L('Explore a topic','了解一个新主题'),prompt:L('Help me get started with a topic I am new to.','帮我快速入门一个新主题。'),point:L('Define the core question, then start with two reliable sources.','先把核心问题说清楚，再找两份可靠的资料。'),detail:L('Make a short reading list with what each source can help you answer.','列一份短书单，标出每份资料能解答什么问题。')},
      coding: {label:L('Coding','编程'),starter:L('Get to know a project','读懂一个项目'),prompt:L('Help me figure out where to start reading this project.','帮我看看这个项目该从哪里读起。'),point:L('Start with the README and the main entry point.','先从 README 和程序入口读起。'),detail:L('Trace one typical request end to end, then find the test that covers it.','跟一遍典型请求的完整链路，再找到覆盖它的测试。')},
      planning: {label:L('Planning','日常规划'),starter:L('Plan my week','安排这周的事'),prompt:L('Help me make a plan for this week.','帮我把这周的事排成一个计划。'),point:L('Place the fixed deadlines first and leave a buffer around them.','先排好有截止时间的事，前后各留一点余量。'),detail:L('Group similar tasks and put the most important one in your first free slot.','把相似的事项放在一起，把最重要的一件放进第一个空档。')},
    },
    looks: {classic:L('Original','原色'),sage:L('Sage','松绿'),blue:L('Mist blue','雾蓝')},
    styles: {warm:L('Friendly','自然亲切'),direct:L('Concise','简明直接'),detailed:L('Step by step','分步讲清')},
  }
}

export function replyExample(prefs:ChatPreferences,L:Localize) {
  const sample = chatPersonalizationCopy(L).purposes[prefs.purpose]
  const name = prefs.name.trim()
  if (prefs.style === 'direct') return [sample.point]
  if (prefs.style === 'detailed') return [sample.point,sample.detail]
  return [L(name ? 'Happy to help, '+name+'.' : 'Happy to help.',name ? '好呀，'+name+'。' : '好呀。')+' '+sample.point]
}
