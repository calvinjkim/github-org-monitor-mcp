/**
 * Run async tasks with bounded concurrency.
 * Returns results in the same order as the input, skipping failures.
 */
export async function mapConcurrent<T, R>(
  items: T[],
  fn: (item: T) => Promise<R | null>,
  concurrency = 5
): Promise<(R | null)[]> {
  const results: (R | null)[] = new Array(items.length).fill(null);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      try {
        results[i] = await fn(items[i]);
      } catch {
        results[i] = null;
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}
