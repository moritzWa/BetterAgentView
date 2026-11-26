//! Incremental OpenCode history listing.
//!
//! The full listing rebuilds every root session's record through views that
//! rewrite each session's last message JSON. On a store of thousands of sessions
//! that is over a second of CPU on every refresh, almost all of it for sessions
//! nobody has touched. Here a cheap per-session change key (event watermark, the
//! newest child watermark and `time_updated`) says which sessions changed; only
//! those, and anything touched in the last few minutes, are rebuilt. Every
//! other record is the exact JSON the full listing returned earlier.
//!
//! Anything unexpected, from an unreadable key row to a missing table, returns
//! `None` and the caller runs the full listing, so this only ever skips work.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// A session touched more recently than this is always rebuilt, whatever its key
/// says. Running sessions change constantly; settled ones almost never do.
pub(super) const SETTLE_MS: u64 = 10 * 60 * 1000;
/// Sessions per rebuild query, so the id list stays a reasonable SQL size.
pub(super) const REBUILD_CHUNK: usize = 300;

pub(super) const KEY_HEADER: &str = "id\tseq\tchild_seq\tupdated";
/// Roots of V2 sessions with their watermarks, plus unmigrated V1 roots, whose
/// rows never change and so carry the fixed marker -2.
pub(super) const KEY_SQL: &str = "SELECT s.id AS id, COALESCE((SELECT e.seq FROM event_sequence e WHERE e.aggregate_id = s.id), -1) AS seq, COALESCE((SELECT MAX(e2.seq) FROM main.session_v2 c JOIN event_sequence e2 ON e2.aggregate_id = c.id WHERE c.parent_id = s.id), -1) AS child_seq, s.time_updated AS updated FROM main.session_v2 s WHERE s.parent_id IS NULL";
pub(super) const KEY_SQL_LEGACY: &str = " UNION ALL SELECT id, -2, -2, time_updated FROM main.session WHERE parent_id IS NULL AND id NOT IN (SELECT id FROM main.session_v2)";
pub(super) const TABLES_SQL: &str = "SELECT name FROM main.sqlite_master WHERE type = 'table' AND name IN ('session_v2', 'event_sequence', 'session')";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Key {
    pub seq: i64,
    pub child_seq: i64,
    pub updated: u64,
}

pub(super) struct Cached {
    key: Key,
    line: String,
    stored: Instant,
}

/// A record is rebuilt at least this often even when its key never moved, so a
/// change the key cannot see (a rename, say) shows within the hour. The
/// per-session spread keeps the rebuilds from all landing in one refresh.
fn lifetime(id: &str) -> Duration {
    let spread = id
        .bytes()
        .fold(0u64, |h, b| h.wrapping_mul(31).wrapping_add(b as u64))
        % 1200;
    Duration::from_secs(20 * 60 + spread)
}

/// Raw record lines of sessions already listed, per OpenCode executable.
type Store = HashMap<String, HashMap<String, Cached>>;

fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(Default::default)
}

/// Parses `id seq child_seq updated` rows. Any other shape is not ours.
pub(super) fn parse_keys(tsv: &str) -> Option<Vec<(String, Key)>> {
    let mut lines = tsv.lines();
    if lines.next()?.trim_end_matches('\r') != KEY_HEADER {
        return None;
    }
    lines
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let mut cells = line.trim_end_matches('\r').split('\t');
            let id = cells.next()?.to_owned();
            let seq = cells.next()?.parse().ok()?;
            let child_seq = cells.next()?.parse().ok()?;
            let updated = cells.next()?.parse().ok()?;
            cells.next().is_none().then_some((
                id,
                Key {
                    seq,
                    child_seq,
                    updated,
                },
            ))
        })
        .collect()
}

/// The sessions one listing covers: the newest `limit` roots (oldest when asked)
/// plus every pinned one that exists.
pub(super) fn window(
    keys: &[(String, Key)],
    limit: usize,
    oldest_first: bool,
    pinned: &BTreeSet<String>,
) -> Vec<(String, Key)> {
    let mut ordered = keys.to_vec();
    ordered.sort_by(|a, b| {
        let by_time = a.1.updated.cmp(&b.1.updated);
        (if oldest_first {
            by_time
        } else {
            by_time.reverse()
        })
        .then_with(|| a.0.cmp(&b.0))
    });
    let mut chosen: Vec<(String, Key)> = ordered.iter().take(limit).cloned().collect();
    let have: BTreeSet<&str> = ordered
        .iter()
        .take(limit)
        .map(|(id, _)| id.as_str())
        .collect();
    let extra: Vec<(String, Key)> = ordered
        .iter()
        .filter(|(id, _)| pinned.contains(id) && !have.contains(id.as_str()))
        .cloned()
        .collect();
    chosen.extend(extra);
    chosen
}

/// Whether a cached record may stand in for a fresh one.
pub(super) fn reusable(cached: Key, current: Key, now_ms: u64) -> bool {
    cached == current && now_ms.saturating_sub(current.updated) >= SETTLE_MS
}

/// Splits the full-listing output into (session id, raw JSON line).
pub(super) fn split_records(tsv: &str) -> Option<Vec<(String, String)>> {
    let mut lines = tsv.lines();
    if lines.next()?.trim_end_matches('\r') != "record" {
        return None;
    }
    lines
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let line = line.trim_end_matches('\r');
            let id = serde_json::from_str::<serde_json::Value>(line)
                .ok()?
                .get("id")?
                .as_str()?
                .to_owned();
            Some((id, line.to_owned()))
        })
        .collect()
}

/// Cached lines for `chosen` that are still valid, and the ids to rebuild.
pub(super) fn plan(
    scope: &str,
    chosen: &[(String, Key)],
    now_ms: u64,
) -> (Vec<(String, String)>, Vec<String>) {
    let guard = store().lock().unwrap_or_else(|e| e.into_inner());
    let known = guard.get(scope);
    let mut reuse = Vec::new();
    let mut rebuild = Vec::new();
    for (id, key) in chosen {
        match known
            .and_then(|k| k.get(id))
            .filter(|c| reusable(c.key, *key, now_ms) && c.stored.elapsed() < lifetime(id))
        {
            Some(cached) => reuse.push((id.clone(), cached.line.clone())),
            None => rebuild.push(id.clone()),
        }
    }
    (reuse, rebuild)
}

/// Remembers the listing just produced and forgets sessions outside it.
pub(super) fn remember(scope: &str, chosen: &[(String, Key)], lines: &[(String, String)]) {
    let keys: HashMap<&str, Key> = chosen.iter().map(|(id, key)| (id.as_str(), *key)).collect();
    let mut next = HashMap::with_capacity(lines.len());
    for (id, line) in lines {
        if let Some(key) = keys.get(id.as_str()) {
            next.insert(
                id.clone(),
                Cached {
                    key: *key,
                    line: line.clone(),
                    stored: Instant::now(),
                },
            );
        }
    }
    store()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(scope.to_owned(), next);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(seq: i64, child: i64, updated: u64) -> Key {
        Key {
            seq,
            child_seq: child,
            updated,
        }
    }

    #[test]
    fn key_rows_parse_strictly() {
        let rows = parse_keys(
            "id\tseq\tchild_seq\tupdated\nses_a\t7\t-1\t1700000000000\nses_b\t-2\t-2\t5\n",
        )
        .unwrap();
        assert_eq!(rows[0], ("ses_a".into(), key(7, -1, 1_700_000_000_000)));
        assert_eq!(rows[1].1, key(-2, -2, 5));
        // A different header, a short row or text instead of numbers is not ours.
        assert!(parse_keys("record\n{}\n").is_none());
        assert!(parse_keys("id\tseq\tchild_seq\tupdated\nses_a\t7\n").is_none());
        assert!(parse_keys("id\tseq\tchild_seq\tupdated\nses_a\tx\t1\t2\n").is_none());
        assert!(parse_keys("id\tseq\tchild_seq\tupdated\nses_a\t1\t1\t2\textra\n").is_none());
        assert!(parse_keys("").is_none());
    }

    #[test]
    fn a_window_is_the_newest_roots_plus_pinned_ones() {
        let keys: Vec<(String, Key)> = (0..6)
            .map(|n| (format!("s{n}"), key(n, -1, 1000 + n as u64)))
            .collect();
        let pinned = BTreeSet::from(["s0".to_string(), "nope".to_string()]);
        let ids = |w: Vec<(String, Key)>| w.into_iter().map(|(id, _)| id).collect::<Vec<_>>();
        assert_eq!(ids(window(&keys, 2, false, &BTreeSet::new())), ["s5", "s4"]);
        assert_eq!(ids(window(&keys, 2, true, &BTreeSet::new())), ["s0", "s1"]);
        assert_eq!(ids(window(&keys, 2, false, &pinned)), ["s5", "s4", "s0"]);
        assert_eq!(window(&keys, 100, false, &BTreeSet::new()).len(), 6);
    }

    #[test]
    fn only_unchanged_and_settled_records_are_reused() {
        let old = 1_000_000;
        let now = old + SETTLE_MS;
        assert!(reusable(key(5, -1, old), key(5, -1, old), now));
        // Moved watermark, moved child watermark or moved clock: rebuild.
        assert!(!reusable(key(5, -1, old), key(6, -1, old), now));
        assert!(!reusable(key(5, -1, old), key(5, 9, old), now));
        assert!(!reusable(key(5, -1, old), key(5, -1, old + 1), now));
        // Touched in the last few minutes: rebuild even when nothing differs.
        assert!(!reusable(key(5, -1, old), key(5, -1, old), now - 1));
    }

    #[test]
    fn record_lines_keep_their_exact_bytes_and_ids() {
        let text = "record\n{\"id\":\"ses_1\",\"title\":\"a\\tb\"}\r\n\n{\"id\":\"ses_2\"}\n";
        let rows = split_records(text).unwrap();
        assert_eq!(
            rows[0],
            (
                "ses_1".into(),
                "{\"id\":\"ses_1\",\"title\":\"a\\tb\"}".into()
            )
        );
        assert_eq!(rows[1].0, "ses_2");
        assert!(split_records("id\n{}").is_none());
        assert!(split_records("record\nnot json\n").is_none());
        assert!(split_records("record\n{\"title\":\"no id\"}\n").is_none());
    }

    #[test]
    fn the_cache_reuses_settled_sessions_and_forgets_those_outside_the_listing() {
        let scope = "test-scope-a";
        let old = 1_000;
        let now = old + SETTLE_MS + 5;
        let chosen = vec![
            ("a".to_string(), key(1, -1, old)),
            ("b".to_string(), key(2, -1, old)),
        ];
        let (reuse, rebuild) = plan(scope, &chosen, now);
        assert!(reuse.is_empty());
        assert_eq!(rebuild, ["a", "b"]);
        remember(
            scope,
            &chosen,
            &[
                ("a".into(), "{\"id\":\"a\"}".into()),
                ("b".into(), "{\"id\":\"b\"}".into()),
            ],
        );
        // b moved on, c is new.
        let next = vec![
            ("a".to_string(), key(1, -1, old)),
            ("b".to_string(), key(3, -1, old)),
            ("c".to_string(), key(1, -1, old)),
        ];
        let (reuse, rebuild) = plan(scope, &next, now);
        assert_eq!(reuse, [("a".to_string(), "{\"id\":\"a\"}".to_string())]);
        assert_eq!(rebuild, ["b", "c"]);
        // Another executable's cache is separate.
        assert_eq!(plan("test-scope-b", &chosen, now).1.len(), 2);
        // A listing without `a` forgets it.
        remember(scope, &next[1..2], &[("b".into(), "{\"id\":\"b\"}".into())]);
        assert_eq!(plan(scope, &chosen, now).1, ["a", "b"]);
    }
}
