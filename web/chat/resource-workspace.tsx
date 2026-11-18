import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Folder, Globe, Users, Plus, X, Maximize2, Minimize2, Search, ArrowUpRight } from 'lucide-react';
import { closeResource, openResource, resourceUrl, type ResourceState, type ResourceKind } from './resource-state.ts';
import { BrowserPanel, type BrowserPages, type BrowserPanelProps } from './browser.tsx';
import './resource-workspace.css';
type Props = {
  state: ResourceState; onChange: (state: ResourceState) => void;
  onOpen: (kind: ResourceKind, url?: string) => void;
  browser?: Pick<BrowserPanelProps, 'conversationId' | 'requestedSession' | 'requestedUrl' | 'onUrlConsumed'>;
  onClose: () => void; expanded: boolean; onExpand: () => void;
  L: (en:string,zh:string)=>string; children: ReactNode;
};
export function ResourceWorkspace({state,onChange,onOpen,onClose,expanded,onExpand,L,children,browser}:Props) {
  const [query,setQuery]=useState('');
  const tabsRef=useRef<HTMLDivElement>(null);
  const active=state.tabs.find(t=>t.id===state.active)!;
  const entries=[
    {kind:'browser' as const,Icon:Globe,label:L('Browser','浏览器')},
    {kind:'files' as const,Icon:Folder,label:L('Files','文件')},
    {kind:'activity' as const,Icon:Users,label:L('Team activity','团队动态')},
  ];
  const meta=(kind:ResourceKind)=>entries.find(e=>e.kind===kind)??{kind:'new',Icon:Plus,label:L('New tab','新标签页')};
  const revealSelected = useCallback((node: HTMLButtonElement | null) => {
    node?.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
  }, []);
  const selectedTab = () => tabsRef.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
  const focusSelected = () => requestAnimationFrame(() => selectedTab()?.focus());
  const closeView = (id:string) => {onChange(closeResource(state,id));focusSelected();};
  const url=resourceUrl(query);
  function renderWorkspace(pages: BrowserPages | undefined, browserContent: ReactNode) {
    // Chromium owns page identity and selection. Only the surrounding resource is stored locally.
    const tools = entries.map(entry => ({
      ...entry, label: entry.kind==='browser' && pages?.canEdit ? L('New webpage','新建网页') : entry.label,
      search: entry.label+' '+entry.kind,
    }));
    const shown = tools.filter(tool => !query || url || (tool.label+' '+tool.search).toLowerCase().includes(query.toLowerCase()));
    const tabs = state.tabs.flatMap(resource => {
      const {Icon,label} = meta(resource.kind);
      const isVisible = resource.id === state.active;
      const show = () => onChange({...openResource(state,resource.kind), active:resource.id});
      if (resource.kind !== 'browser' || !pages?.tabs.length) {
        return [{id: resource.id, Icon, label, selected: isVisible, disabled: false,
          closeLabel: L('Close ','关闭')+label+L(' view','视图'), closeDisabled: false, page: false,
          select: show, close: () => closeView(resource.id)}];
      }
      const last = pages.tabs.length === 1;
      const currentPage = pages.tabs.find(tab => tab.active) ?? pages.tabs[0]!;
      return pages.tabs.map(page => {
        const current = page.id === currentPage.id;
        const pageLabel = page.url === 'about:blank' ? L('Blank page','空白页') : page.title || page.url;
        return {
          id: resource.id+'-'+pages.sessionId+'-'+page.id, Icon, label: pageLabel,
          page: true, selected: isVisible && current, disabled: !current && !pages.canEdit,
          closeLabel: last ? L('Close browser view','关闭浏览器视图') : L('Close tab ','关闭标签页 ')+pageLabel,
          closeDisabled: !last && !pages.canEdit,
          select: () => { if (!isVisible) show(); if (!current) void pages.select(page.id); },
          close: () => { if (last) closeView(resource.id); else void pages.close(page.id).then(focusSelected); },
        };
      });
    });
    const selected = tabs.find(tab => tab.selected)!;
    const openTool = (kind: ResourceKind) => {
      onOpen(kind);
      if (kind === 'browser' && pages?.canEdit) void pages.create();
    };
    return <aside id="session-panel" className={'session-panel resource-workspace'+(expanded?' expanded':'')} aria-label={L('Session panel','会话面板')}>
    <header className="resource-tabbar">
      <div className="resource-tabs" role="tablist" ref={tabsRef} aria-label={L('Workspace tabs','工作标签页')}
        onKeyDown={event=>{
          if((event.target as HTMLElement).getAttribute('role')!=='tab')return;
          const available=tabs.filter(tab=>!tab.disabled);
          const index=available.findIndex(tab=>'resource-tab-'+tab.id===(event.target as HTMLElement).id);
          let next:number|undefined;
          if(event.key==='ArrowRight')next=(index+1)%available.length;
          if(event.key==='ArrowLeft')next=(index+available.length-1)%available.length;
          if(event.key==='Home')next=0;
          if(event.key==='End')next=available.length-1;
          if(event.key==='Delete'){event.preventDefault();const target=available[index];if(target&&!target.closeDisabled)target.close();return;}
          if(next!==undefined){event.preventDefault();const tab=available[next]!;tab.select();document.getElementById('resource-tab-'+tab.id)?.focus();}
        }}>
        {tabs.map(({id,Icon,label,selected,disabled,closeLabel,closeDisabled,page,select,close})=>
          <div className={'resource-tab'+(selected?' active':'')} key={id} data-webpage={page || undefined}>
            <button role="tab" id={'resource-tab-'+id} aria-selected={selected} aria-controls="resource-content"
              ref={selected?revealSelected:undefined} tabIndex={selected?0:-1} onClick={select} title={label} disabled={disabled}>
              <Icon size={15}/><span>{label}</span>
            </button>
            <button className="resource-tab-close" tabIndex={selected?0:-1} aria-label={closeLabel}
              title={closeLabel} disabled={closeDisabled} onClick={close}><X size={13}/></button>
          </div>)}
      </div>
      <button className="icon-button resource-add" onClick={()=>{onOpen('new');setQuery('');}} aria-label={L('New workspace tab','新建工作标签页')} title={L('New tab','新标签页')}><Plus size={17}/></button>
      <div className="resource-window-actions">
        <button className="icon-button" onClick={onExpand} aria-label={expanded?L('Collapse panel','缩小面板'):L('Expand panel','展开面板')} title={expanded?L('Collapse panel','缩小面板'):L('Expand panel','展开面板')}>{expanded?<Minimize2 size={15}/>:<Maximize2 size={15}/>}</button>
        <button className="icon-button" onClick={onClose} aria-label={L('Close panel','收起面板')} title={L('Close panel','收起面板')}><X size={17}/></button>
      </div>
    </header>
    <div className="session-panel-content" role="tabpanel" id="resource-content" aria-labelledby={'resource-tab-'+selected.id}>
      {active.kind==='new'?<div className="resource-start">
        <form className="resource-search" onSubmit={e=>{e.preventDefault();if(url){onOpen('browser',url);setQuery('');}else if(shown.length===1)openTool(shown[0]!.kind);}}>
          <Search size={16}/><input value={query} onChange={e=>setQuery(e.target.value)} aria-label={L('Search tools or enter a website','搜索工具或输入网址')} placeholder={L('Search tools or enter a website','搜索工具或输入网址')}/>
          {url?<button type="submit" className="icon-button" aria-label={L('Open website','打开网站')}><ArrowUpRight size={16}/></button>:null}
        </form>
        <div className="resource-start-scroll">
          <section className="resource-tools"><h2>{L('Tools','工具')}</h2><div className="resource-tool-grid">
            {shown.map(({kind,Icon,label})=><button key={kind} onClick={()=>openTool(kind)}><Icon size={18}/><span>{label}</span><ArrowUpRight size={14}/></button>)}
          </div>{!shown.length?<p className="resource-no-results">{L('No matching tools','没有匹配的工具')}</p>:null}</section>
          {state.recent.length&&!query?<section className="resource-recent"><h2>{L('Recent','最近')}</h2>
            {state.recent.map(r=>{const {Icon,label}=meta(r.kind);return <button key={r.kind} onClick={()=>onOpen(r.kind)}><span className="resource-recent-icon"><Icon size={18}/></span><span>{label}</span><time dateTime={new Date(r.at).toISOString()}>{new Intl.DateTimeFormat(L('en','zh-CN'),{hour:'2-digit',minute:'2-digit'}).format(r.at)}</time></button>;})}
          </section>:null}
        </div>
      </div>:active.kind==='browser'?browserContent:children}
    </div>
  </aside>;
  }
  if (browser && state.tabs.some(tab => tab.kind === 'browser'))
    return <BrowserPanel {...browser} L={L} visible={active.kind==='browser'} renderWorkspace={renderWorkspace}/>;
  return renderWorkspace(undefined, null);
}
