/** Request phase timings for the Server-Timing response header. Durations only:
 * no text, SQL, identifiers or arguments, so the header is safe to send to any
 * authenticated client and to keep in a trace. */
export class Timing {
  constructor() { this.phases = new Map(); }
  add(name, ms) {
    const phase = this.phases.get(name) ?? { ms: 0, n: 0 };
    phase.ms += ms;
    phase.n++;
    this.phases.set(name, phase);
  }
  async time(name, fn) {
    const started = performance.now();
    try { return await fn(); } finally { this.add(name, performance.now() - started); }
  }
  /** A fact about the call that is not a duration, such as the result size. */
  note(name, value) { (this.notes ??= new Map()).set(name, value); }
  header() {
    const phases = [...this.phases].map(([name, { ms, n }]) => `${name};dur=${ms.toFixed(1)};desc="n=${n}"`);
    const notes = [...(this.notes ?? [])].map(([name, value]) => `${name};desc="${value}"`);
    return [...phases, ...notes].join(', ');
  }
}

/** Same interface, every query and transaction counted under `db` / `db_tx`. */
export function timedDatabase(db, timing) {
  return new Proxy(db, { get(target, name) {
    const value = Reflect.get(target, name, target);
    if (name === 'query') return (sql, args) => timing.time('db', () => target.query(sql, args));
    if (name === 'transaction') return fn => timing.time('db_tx', () => target.transaction(fn));
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

/** A wait for the Mac to refresh is the one gate call worth its own name. */
export function timedGate(gate, timing) {
  return Object.fromEntries(Object.entries(gate).map(([name, fn]) => [name, (...args) => {
    const label = name === 'activity' && args[1] ? 'fresh_wait' : name === 'waitReceipt' ? 'receipt_wait' : 'gate';
    return timing.time(label, () => fn(...args));
  }]));
}
