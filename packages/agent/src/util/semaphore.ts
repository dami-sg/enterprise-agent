/** Bounded concurrency gate for parallel sub-agent delegation (agent §2.3 pt.3). */
export class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    // Either take a free slot now, or wait for a releaser to hand one off. We do
    // NOT increment on wake: the releaser keeps the slot count steady and passes
    // ownership directly, which closes the over-admission window that exists if
    // `active++` runs after the await (another acquire could slip in while the
    // woken waiter's microtask is still pending).
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.active++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next(); // hand the slot to the next waiter without decrementing
      else this.active--;
    };
  }
}
