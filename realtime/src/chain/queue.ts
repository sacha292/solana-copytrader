/**
 * Serialises copy work. Two wallets can fire in the same millisecond, and both
 * read then write portfolio.cashUSD — without a queue that is a lost update.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    // Keep the chain alive even when a task rejects.
    this.tail = result.catch(() => undefined);
    return result;
  }
}
