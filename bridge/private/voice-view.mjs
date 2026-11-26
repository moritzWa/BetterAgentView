import {fullMessageReference} from './excerpt.mjs';

/** The voice response is a review list, not a copy of the dashboard debugger. */
export function voiceView(view) {
 const nonzero=counts=>counts?Object.fromEntries(Object.entries(counts).filter(([key,n])=>key==='total'||n>0)):null;
 const warnings=[];
 if(!view.available)warnings.push('Current Agent View snapshot unavailable. Do not substitute historical session counts.');
 else if(!view.exact)warnings.push('UI snapshot is stale or partial; counts are last observed.');
 if(view.directory_found===false)warnings.push('No visible directory matches that path.');
 const review=new Set(view.review_ids??[]);
 const rows=view.directories.flatMap(d=>[...d.sessions,...d.working]);
 if(rows.some(s=>s.context_state==='budget_limited'))warnings.push('Some previews did not fit. Select a directory or use session_brief for one session.');
 if(rows.some(s=>s.context_state&&!['available','budget_limited'].includes(s.context_state)))warnings.push('Some message context is unavailable; use session_brief for the selected session.');
 else if(rows.some(s=>s.context_fresh===false))warnings.push('Recent messages may lag the Mac; check session_brief before acting.');
 const session=s=>{
  const user=s.recent_messages?.find(m=>m.role==='user');
  const agent=s.recent_messages?.find(m=>m.role==='assistant');
  return {id:s.id,title:s.title,status:s.category,user:user?.text??null,agent:agent?.text??null,
   ...(user?.truncated?{user_truncation:fullMessageReference(user.message_id)}:{}),
   ...(agent?.truncated?{agent_truncation:fullMessageReference(agent.message_id)}:{}),
   ...(s.category==='working'&&review.has(s.id)?{review:true}:{}),
  };
 };
 return {counts:nonzero(view.counts),directories:view.directories.map(d=>({
  path:d.path,label:d.label,counts:nonzero(d.counts),
  sessions:d.sessions.map(session),working:d.working.map(session),
 })),...(warnings.length?{warning:warnings.join(' ')}:{})};
}

/** Keep complete opening/concluding units, never chopped head/tail fragments. */
export function readableExcerpt(row,budget) {
 if(Number(row.total_characters)<=budget)return row.text_head;
 const size=s=>[...s].length;
 const boundaries=text=>[...text.matchAll(/(?:[.!?][*_"')\]]{0,4}(?=\s|$)|\n+)/gu)].map(m=>m.index+m[0].length);
 const head=row.text_head??'',tail=row.text_tail??'';
 const openings=boundaries(head).map(end=>head.slice(0,end).trim()).filter(Boolean);
 // Tail starts at an unknown offset. Discard its first partial unit.
 const endings=boundaries(tail).map(start=>tail.slice(start).trim()).filter(Boolean);
 const suffixes=endings.filter(s=>size(s)+2<=budget).sort((a,b)=>size(b)-size(a));
 const closing=suffixes.find(s=>size(s)<=budget*0.6)??suffixes.at(-1);
 if(closing) {
  const opening=openings.filter(s=>size(s)+size(closing)+5<=budget).at(-1);
  return opening?opening+' […] '+closing:'… '+closing;
 }
 const opening=openings.filter(s=>size(s)+2<=budget).at(-1);
 return opening?opening+' …':null;
}
