// Pure helpers: what the model may honestly say about one send. No I/O.
// claim_ceiling is the strongest claim allowed: none < queued < accepted < completed.

export const REPORT_RULE='Report status only when asked or when the owner needs to act. Never claim more than claim_ceiling. Queued means saved for automatic pickup. Accepted means OpenCode queued it for processing, not that it appeared as a user turn or finished. Only report a completed turn after confirmed completion.';

const SAYS={
  not_sent:'Not sent. Nothing reached the session.',
  queued_mac_offline:'Message saved for automatic pickup when your Mac reconnects.',
  queued_waiting_for_mac:'Message saved for automatic pickup.',
  accepted_by_session:'OpenCode queued your message for processing.',
  accepted_behind_running_turn:'OpenCode accepted your message. At the last check it was queued behind the running turn.',
  completed_confirmed:'The session got it, finished, and replied.',
  needs_confirmation:'It is held. The session changed after you decided. I need your OK before it goes.',
  needs_confirmation_blocked:'It is waiting behind an earlier message that needs your OK.',
  rejected_stale_context:'Not sent. The session changed after I read it. I will re-read it and ask you once.',
  cancelled:'That message was cancelled. The session never got it.',
  failed:'The Mac reported it could not hand the message to OpenCode.',
  expired:'It waited a day and expired. The session never saw it.',
  uncertain:'I cannot confirm whether OpenCode accepted the message.',
};

const view=(delivery_state,claim_ceiling,owner_action='none',say=delivery_state)=>({
  delivery_state,say_to_owner:SAYS[say],claim_ceiling,owner_action,report_rule:REPORT_RULE});

/** @param receipt public outbox receipt (status, blocked_by?)
 *  @param freshness gate.activity result (mac_seen_recently)
 *  @param completion true only when a native completed state and a correlated reply are confirmed
 *  @param behindRunningTurn true only when the last check showed an earlier turn still running */
export function deliveryView(receipt,freshness={},completion=false,behindRunningTurn=false) {
  switch(receipt?.status) {
    case 'queued':
    case 'leased': {
      if(['needs_confirmation','uncertain'].includes(receipt.blocked_by?.status))return view('needs_confirmation','none','reconfirm','needs_confirmation_blocked');
      return freshness.mac_seen_recently===false?view('queued_mac_offline','queued'):view('queued_waiting_for_mac','queued');
    }
    case 'accepted':return completion?view('completed_confirmed','completed'):view('accepted_by_session','accepted','none',behindRunningTurn?'accepted_behind_running_turn':'accepted_by_session');
    case 'needs_confirmation':return view('needs_confirmation','none','reconfirm');
    case 'cancelled':return view('cancelled','none');
    case 'failed':return view('failed','none','retry');
    case 'expired':return view('expired','none');
    default:return view('uncertain','none');
  }
}

const err=(delivery_state,say,next_step,{sent=false,retry_same_operation=false,owner_action='none'}={})=>({
  delivery_state,sent,claim_ceiling:'none',say_to_owner:SAYS[say]??say,owner_action,next_step,retry_same_operation});

const STALE='Re-read the session, tell the owner what changed in one sentence, ask yes or no once, then call send_session_message with a NEW operation_id only after a clear yes.';
const ERRORS={
  context_changed_re_read_and_confirm:()=>err('rejected_stale_context','rejected_stale_context',STALE,{owner_action:'reconfirm'}),
  history_changed_re_read_and_confirm:()=>err('rejected_stale_context','rejected_stale_context',STALE,{owner_action:'reconfirm'}),
  device_disconnected:()=>err('not_sent','Not sent. Your Mac connector is not connected.','Tell the owner. Do not retry.'),
  session_not_found:()=>err('not_sent','Not sent. I cannot find that session.','Ask the owner which session they mean.'),
  write_permission_required:()=>err('not_sent','Not sent. This connection cannot send.','Tell the owner to check the AgentVoice connection.'),
  operation_id_conflict:()=>err('not_sent','Not sent. I reused an id with different text.','Ask once if the owner still wants it, then use a NEW operation_id.'),
  invalid_message:()=>err('not_sent','Not sent. My request was malformed.','Fix the arguments and retry once with the same operation_id and text.',{retry_same_operation:true}),
  invalid_read_context:()=>err('not_sent','Not sent. My request was malformed.','Re-read the session and retry once.',{retry_same_operation:true}),
  unauthorized:()=>err('not_sent','Not sent. The connection needs a new sign-in.','Tell the owner.'),
  message_not_found:()=>err('not_sent','Nothing was sent with that id.','Do not claim a send. Ask the owner whether to send it now.'),
  cannot_cancel_admitted_or_inflight_message:()=>err('uncertain','I could not cancel it. OpenCode may already have accepted it.','Call message_status for this operation_id before saying anything else.',{sent:null}),
  receipt_conflict:()=>err('uncertain','uncertain','Call message_status for this operation_id before saying anything else.',{sent:null}),
  invalid_directory:()=>err('not_sent','Not started. That path is not a usable directory.','Ask for a project directory, then retry once with the same operation_id.',{retry_same_operation:true}),
  directory_not_allowed:()=>err('not_sent','Not started. That directory is not allowed.','Ask for a project folder under the home directory, not a system or credential folder.'),
  invalid_start:()=>err('not_sent','Not started. My request was malformed.','Fix the arguments and retry once with the same operation_id.',{retry_same_operation:true}),
  start_not_found:()=>err('not_sent','Nothing was started with that id.','Do not claim a session exists.'),
};

/** Structured body for a failed send, cancel or status call. Unknown codes are uncertain, never "not sent". */
export function errorView(code,enqueue=false) {
  if(enqueue&&!Object.hasOwn(ERRORS,code))return {error:code,...err('uncertain','I could not confirm the request was saved.','If retrying, reuse the exact operation_id and arguments. Do not submit a new operation.',{sent:null,retry_same_operation:true})};
  const build=ERRORS[code]??(()=>err('uncertain','Something failed and I do not know if it was sent.','Call message_status for this operation_id before saying anything else.',{sent:null}));
  return {error:code,...build(),report_rule:REPORT_RULE};
}
