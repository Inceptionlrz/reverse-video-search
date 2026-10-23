// 并发池 + 节流：全局并发上限、按 key（引擎）并发上限与最小请求间隔。
// 暂停后不再取新任务，已在跑的允许跑完；取消会拒绝全部排队项。
export class Runner {
  constructor(options = {}) {
    this.concurrency = options.concurrency || 2;
    this.perKeyConcurrency = options.perKeyConcurrency || 1;
    this.minIntervalMs = options.minIntervalMs || 1200;
    this.jitter = options.jitter ?? 0.2;
    this.jobs = [];
    this.running = 0;
    this.runningByKey = new Map();
    this.lastStartByKey = new Map();
    this.paused = false;
    this.timer = null;
  }

  get pendingCount() {
    return this.jobs.length;
  }

  get runningCount() {
    return this.running;
  }

  enqueue(key, fn) {
    return new Promise((resolve, reject) => {
      this.jobs.push({ key, fn, resolve, reject });
      this.schedule(0);
    });
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.schedule(0);
  }

  cancelPending(reason = 'cancelled') {
    const pending = this.jobs.splice(0, this.jobs.length);
    for (const job of pending) job.reject(Object.assign(new Error(reason), { cancelled: true }));
    return pending.length;
  }

  intervalWithJitter() {
    const factor = 1 + (Math.random() * 2 - 1) * this.jitter;
    return Math.max(0, Math.round(this.minIntervalMs * factor));
  }

  nextRunnableIndex() {
    const now = Date.now();
    for (let i = 0; i < this.jobs.length; i += 1) {
      const job = this.jobs[i];
      if ((this.runningByKey.get(job.key) || 0) >= this.perKeyConcurrency) continue;
      const last = this.lastStartByKey.get(job.key) || 0;
      if (now - last < this.minIntervalMs) continue;
      return i;
    }
    return -1;
  }

  throttleDelay() {
    const now = Date.now();
    let wait = 0;
    for (const [, last] of this.lastStartByKey) {
      const remaining = this.minIntervalMs - (now - last);
      if (remaining > wait) wait = remaining;
    }
    return wait;
  }

  schedule(delayMs) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.paused) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain();
    }, delayMs);
    if (this.timer.unref && process.env.RVS_TEST_MODE) this.timer.unref();
  }

  drain() {
    if (this.paused) return;
    while (this.running < this.concurrency) {
      const index = this.nextRunnableIndex();
      if (index < 0) break;
      const job = this.jobs.splice(index, 1)[0];
      this.start(job);
      this.pump();
      return;
    }
    const wait = this.throttleDelay();
    if (this.jobs.length && wait > 0) this.schedule(wait + 10);
  }

  // 出队一个可执行项后，递归调度其余项（受节流约束时挂定时器）。
  pump() {
    if (this.paused) return;
    if (this.running >= this.concurrency) return;
    const index = this.nextRunnableIndex();
    if (index >= 0) {
      const job = this.jobs.splice(index, 1)[0];
      this.start(job);
      this.pump();
      return;
    }
    const wait = this.throttleDelay();
    if (this.jobs.length && wait > 0) this.schedule(wait + 10);
  }

  start(job) {
    this.running += 1;
    this.runningByKey.set(job.key, (this.runningByKey.get(job.key) || 0) + 1);
    this.lastStartByKey.set(job.key, Date.now());
    Promise.resolve()
      .then(() => job.fn())
      .then(job.resolve, job.reject)
      .finally(() => {
        this.running -= 1;
        this.runningByKey.set(job.key, Math.max(0, (this.runningByKey.get(job.key) || 1) - 1));
        if (!this.paused) this.schedule(this.intervalWithJitter());
        else if (!this.jobs.length) this.schedule(0);
      });
  }
}

export function createRunner(options) {
  return new Runner(options);
}
