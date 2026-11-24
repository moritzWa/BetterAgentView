import {DashboardSnapshot} from '../contracts/contract.mjs';

export const REVIEW_RULES='Review one directory at a time using directories and its review_ids; select it with directory=directory_id or its exact path. Within it review one session at a time: Needs Input first, Task Done second, Project Done last. Working is listed separately; skip it unless fresh native health says potentially_stalled or a decision is pending. Track reviewed stable id values, refresh before the next item, and skip IDs no longer present. Read session_brief using session_id only for paired host OpenCode rows. Task Done leaves the project open. Never ask whether to close after each review, and never hide, archive or close based on a completion label. Idle is unconfirmed completion, not Task Done.';
export async function listVisibleSessions({gate,principal},{directory}={}) {
  const source=`${principal.device_id}|${principal.database_epoch}`;
  const freshness=await gate.activity(source,true,'runtime',{max_wait:8000});
  const runtime=await gate.runtime(source);
  return visibleView(runtime,freshness,Date.now(),{directory});
}

export function visibleView(runtime,freshness={},now=Date.now(),{directory}={}) {
  const dashboard=runtime.dashboard?DashboardSnapshot.parse(runtime.dashboard):null;
  const status_fresh=Boolean(dashboard&&freshness.mac_seen_recently&&runtime.checked_at>now-30_000&&dashboard.captured_at>now-30_000&&dashboard.captured_at<=now);
  const exact=Boolean(status_fresh&&!dashboard.partial);
  const native_status_fresh=Boolean(runtime.available&&!runtime.partial&&freshness.mac_seen_recently&&runtime.checked_at>now-30_000);
  if(!dashboard)return {available:false,exact:false,status_fresh:false,dashboard:null,counts:null,displayed_counts:null,directories:[],review_ids:[],note:'No live dashboard snapshot. Restart an updated Agent View dashboard if needed. The historical inventory is NOT a substitute for the displayed set.'};
  const categories=['needs_input','working','task_done','project_done','idle','ready_for_review','scheduled','paused','unknown'];
  const count=(rows,listed=false)=>{
    const result=Object.fromEntries(categories.map(k=>[k,0]));result.total=0;
    for(const s of rows){if(listed&&!s.listed)continue;result[s.category]++;result.total++;}
    return result;
  };
  const selected=dashboard.sessions.filter(s=>!directory||s.directory_id===directory||s.directory_path===directory);
  const counts=count(selected),displayed_counts=count(selected,true);
  const native=new Map((runtime.statuses??[]).map(s=>[s.session_id,s]));
  const priority=s=>{
    if(s.category==='needs_input')return 0;
    if(s.category==='task_done')return 1;
    const n=s.id.startsWith('opencode:host:')?native.get(s.session_id):null;
    if(s.category==='working'&&status_fresh&&native_status_fresh&&(n?.health==='potentially_stalled'||['question','approval','reply'].includes(n?.reason)))return 2;
    if(s.category==='project_done')return 3;
    return null;
  };
  const review=rows=>exact?rows.filter(s=>priority(s)!==null).sort((a,b)=>priority(a)-priority(b)).map(s=>s.id):[];
  const grouped=new Map();
  for(const s of selected){if(!grouped.has(s.directory_id))grouped.set(s.directory_id,[]);grouped.get(s.directory_id).push(s);}
  const directories=[...grouped.values()].sort((a,b)=>a[0].directory_path<b[0].directory_path?-1:a[0].directory_path>b[0].directory_path?1:0).map(rows=>({
    directory_id:rows[0].directory_id,path:rows[0].directory_path,label:rows[0].directory_label,
    counts:count(rows),displayed_counts:count(rows,true),
    sessions:rows.filter(s=>s.category!=='working').sort((a,b)=>(a.category==='project_done'?4:priority(a)??3)-(b.category==='project_done'?4:priority(b)??3)),
    working:rows.filter(s=>s.category==='working'),review_ids:review(rows),
  }));
  const review_ids=review(selected);
  return {available:true,exact,status_fresh,native_status_fresh,dashboard,counts,displayed_counts,directories,review_ids,status_observed_at:runtime.checked_at,directory_filter:directory??null,directory_found:!directory||directories.length>0,dashboard_counts:count(dashboard.sessions),
    counts_scope:'Current dashboard group membership after UI discovery, visibility and filters, intersected with directory selection. Group totals include collapsed and Show More rows. displayed_counts includes only expanded/paged rows, not viewport clipping. dashboard is the unmodified source snapshot; directories, counts and review_ids are the selected result.',
    note:(exact?'':'Snapshot is stale or partial. Counts are last observed, not exact current counts; review is paused. ')+REVIEW_RULES};
}
