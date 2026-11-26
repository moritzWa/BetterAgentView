// Dashboard IDs identify provider and host. Only the paired local OpenCode
// namespace maps to the raw ID used by history and native delivery.
export function pairedSessionId(id) {
  return id.replace(/^opencode:host:/,'');
}
