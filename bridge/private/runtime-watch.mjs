// Pure timestamps only. Sleep/offline resets continuity; idle sync is 15 minutes.
export const WATCH={onlineGap:90_000,grace:120_000,activeStale:120_000,idleStale:20*60_000};
export function runtimeWatch(now,{last_seen=null,runtime_checked=null,active_until=0}={},previous={}) {
  const seen=previous.last_poll??last_seen;
  const continuous=seen!==null&&now-seen<=WATCH.onlineGap;
  const since=continuous?(previous.since??now):now;
  const limit=active_until>now?WATCH.activeStale:WATCH.idleStale;
  const age=runtime_checked===null?now-since:Math.max(0,now-runtime_checked);
  const unhealthy=continuous&&now-since>=WATCH.grace&&age>=limit;
  const ongoing=continuous&&previous.incident&&(runtime_checked===null||runtime_checked<previous.incident);
  return {since,last_poll:now,incident:unhealthy||ongoing?(previous.incident??now):null,stale_for_ms:age};
}
