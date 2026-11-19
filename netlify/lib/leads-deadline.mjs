// One request budget, including request parsing, storage and response-body reads.
// Keep a response margin below Netlify's synchronous function limit.
export function deadline(total = 9000, clock = () => performance.now()) {
  const end = clock() + Math.min(total, 9000);
  const reserve = Math.min(250, total / 10);
  const remaining = () => Math.max(0, end - clock() - reserve);
  const expired = () => Object.assign(new Error('Request deadline'), { name: 'TimeoutError' });
  async function run(operation, cap = Infinity) {
    const ms = Math.min(remaining(), cap);
    if (ms <= 0) throw expired();
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => operation(controller.signal)),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(expired()); }, ms); })
      ]);
    } finally { clearTimeout(timer); controller.abort(); }
  }
  return { remaining, run };
}

export const boundedStore = (store, budget) => ({
  getWithMetadata: (...args) => budget.run(() => store.getWithMetadata(...args)),
  set: (...args) => budget.run(() => store.set(...args))
});

// Keep the SDK transport abortable through the response body, not just headers.
// The outer store race separately bounds parsing and SDK retry delays.
export const storageFetch = (fetcher, budget) => (url, options) => budget.run(async signal => {
  const response = await fetcher(url, { ...options, signal });
  const bytes = await response.arrayBuffer();
  return new Response([204, 205, 304].includes(response.status) ? null : bytes, {
    status: response.status, statusText: response.statusText, headers: response.headers
  });
});
