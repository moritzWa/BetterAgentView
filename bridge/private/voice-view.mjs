/** The voice response is a review list, not a copy of the dashboard debugger. */
export function voiceView(view) {
 const nonzero=counts=>counts?Object.fromEntries(Object.entries(counts).filter(([key,n])=>key==='total'||n>0)):null;
 const warnings=[];
 if(!view.available)warnings.push('Current Agent View snapshot unavailable. Do not substitute historical session counts.');
 else if(!view.exact)warnings.push('UI snapshot is stale or partial; counts are last observed.');
 if(view.directory_found===false)warnings.push('No visible directory matches that path.');
 const review=new Set(view.review_ids??[]);
 const rows=view.directories.flatMap(d=>[...d.sessions,...d.working]);
 if(rows.some(s=>s.context_state&&s.context_state!=='available'))warnings.push('Some message context is unavailable; use session_brief for the selected session.');
 else if(rows.some(s=>s.context_fresh===false))warnings.push('Recent messages may lag the Mac; check session_brief before acting.');
 const session=s=>({
  id:s.id,title:s.title,status:s.category,
  user:s.recent_messages?.find(m=>m.role==='user')?.text??null,
  agent:s.recent_messages?.find(m=>m.role==='assistant')?.text??null,
  ...(s.category==='working'&&review.has(s.id)?{review:true}:{}),
 });
 return {counts:nonzero(view.counts),directories:view.directories.map(d=>({
  path:d.path,label:d.label,counts:nonzero(d.counts),
  sessions:d.sessions.map(session),working:d.working.map(session),
 })),...(warnings.length?{warning:warnings.join(' ')}:{})};
}

/** Prefix only, with whole Unicode characters and natural stopping points. */
export function readableExcerpt(row,budget) {
 const chars=[...row.text_head];
 if(Number(row.total_characters)<=budget)return row.text_head;
 const limit=Math.max(0,budget-1),raw=chars.slice(0,limit).join(''),prefix=raw.trimEnd();
 const sentences=[...prefix.matchAll(/[.!?](?=\s|$)/gu)];
 const last=sentences.at(-1);
 if(last&&last.index>=prefix.length/2)return prefix.slice(0,last.index+1)+'…';
 if(/\s$/u.test(raw)||/[\s.,;:!?]/u.test(chars[limit]??''))return prefix+'…';
 const boundary=prefix.search(/\s+\S*$/u);
 return (boundary>0?prefix.slice(0,boundary):prefix)+'…';
}
