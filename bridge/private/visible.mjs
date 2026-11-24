import {DashboardSnapshot} from '../contracts/contract.mjs';

export const REVIEW_RULES='Review one session at a time: Needs Input first, Task Done second, Project Done last. Skip Working unless fresh native health says potentially_stalled or a decision is pending. Track reviewed stable id values, refresh before the next item, and skip IDs no longer present. Read session_brief using session_id only for paired host OpenCode rows. Task Done leaves the project open. Never ask whether to close after each review, and never hide, archive or close based on a completion label. Idle is unconfirmed completion, not Task Done.';
export async function listVisibleSessions({gate,principal}) {
  const source=`${principal.device_id}|${principal.database_epoch}`;
  const freshness=await gate.activity(source,true,'runtime',{max_wait:8000});
  const runtime=await gate.runtime(source);
  return visibleView(runtime,freshness);
}

export function visibleView(runtime,freshness={},now=Date.now()) {
  const dashboard=runtime.dashboard?DashboardSnapshot.parse(runtime.dashboard):null;
  const status_fresh=Boolean(dashboard&&freshness.mac_seen_recently&&runtime.checked_at>now-30_000&&dashboard.captured_at>now-30_000&&dashboard.captured_at<=now);
  const exact=Boolean(status_fresh&&!dashboard.partial);
  const native_status_fresh=Boolean(runtime.available&&!runtime.partial&&freshness.mac_seen_recently&&runtime.checked_at>now-30_000);
  if(!dashboard)return {available:false,exact:false,status_fresh:false,dashboard:null,counts:null,displayed_counts:null,review_ids:[],note:'No live dashboard snapshot. Restart an updated Agent View dashboard if needed. The historical inventory is NOT a substitute for the displayed set.'};
  const categories=['needs_input','working','task_done','project_done','idle','ready_for_review','scheduled','paused','unknown'];
  const counts=Object.fromEntries(categories.map(k=>[k,0])),displayed_counts={...counts};
  for(const s of dashboard.sessions){counts[s.category]++;if(s.listed)displayed_counts[s.category]++;}
  counts.total=dashboard.sessions.length;displayed_counts.total=dashboard.sessions.filter(s=>s.listed).length;
  const native=new Map((runtime.statuses??[]).map(s=>[s.session_id,s]));
  const priority=s=>{
    if(s.category==='needs_input')return 0;
    if(s.category==='task_done')return 1;
    const n=s.id.startsWith('opencode:host:')?native.get(s.session_id):null;
    if(s.category==='working'&&status_fresh&&native_status_fresh&&(n?.health==='potentially_stalled'||['question','approval','reply'].includes(n?.reason)))return 2;
    if(s.category==='project_done')return 3;
    return null;
  };
  const review_ids=exact?dashboard.sessions.filter(s=>priority(s)!==null).sort((a,b)=>priority(a)-priority(b)).map(s=>s.id):[];
  return {available:true,exact,status_fresh,native_status_fresh,dashboard,counts,displayed_counts,review_ids,status_observed_at:runtime.checked_at,
    counts_scope:'Current dashboard group membership after UI discovery, visibility and filters; group totals include collapsed and Show More rows. displayed_counts includes only expanded/paged rows, not viewport clipping.',
    note:(exact?'':'Snapshot is stale or partial. Counts are last observed, not exact current counts; review is paused. ')+REVIEW_RULES};
}
