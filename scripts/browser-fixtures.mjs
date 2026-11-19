// Small deterministic browser fixtures for client lifecycle regression tests.
export const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function clock() {
  let now = 0, id = 0;
  const timers = new Map();
  return {
    timers, now: () => now,
    setTimeout(fn, ms) { timers.set(++id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const end = now + ms;
      await flush();
      while (true) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      now = end; await flush();
    }
  };
}
export function element(text = '') {
  const classes = new Set(), attrs = {}, handlers = {}, children = [];
  let value = text;
  return {
    attrs, handlers, children, hidden: false, disabled: false, dataset: {},
    style: { removeProperty(prop) { delete this[prop]; if (prop === 'z-index') delete this.zIndex; } },
    classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x), toggle(x, on) { on ? classes.add(x) : classes.delete(x); } },
    get textContent() { return value + children.map(c => c.textContent).join(''); },
    set textContent(text) { value = text; children.length = 0; },
    setAttribute(k, v) { attrs[k] = v; }, getAttribute(k) { return attrs[k] ?? null; }, removeAttribute(k) { delete attrs[k]; },
    appendChild(el) { children.push(el); }, prepend(el) { children.unshift(el); },
    addEventListener(type, fn) { handlers[type] = fn; }, focus() {},
    replaceWith(el) { this.replacement = el; }, querySelector() { return null; }, querySelectorAll() { return []; }
  };
}
