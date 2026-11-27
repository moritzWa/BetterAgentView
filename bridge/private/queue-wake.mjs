// The connector also reconciles the durable queue if this wake fails.
export async function wakeQueue(gate,principal,defer) {
  const wake=Promise.resolve().then(()=>gate.signal(`${principal.device_id}|${principal.database_epoch}`)).catch(()=>console.error('bridge_queue_signal_failed'));
  if(defer)defer(wake);
  else await wake;
}
