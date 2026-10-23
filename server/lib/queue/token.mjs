// 取消令牌：回调驱动，不持有调用方类型。用于中断 socket 与 ffmpeg 子进程。
export class CancelToken {
  constructor() {
    this.isCancelled = false;
    this.reason = null;
    this.handlers = new Set();
  }

  onAbort(fn) {
    if (this.isCancelled) {
      try {
        fn(this.reason);
      } catch {
        // 回调异常不影响取消流程
      }
      return () => {};
    }
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  offAbort(fn) {
    this.handlers.delete(fn);
  }

  abort(reason = 'cancelled') {
    if (this.isCancelled) return;
    this.isCancelled = true;
    this.reason = reason;
    for (const fn of [...this.handlers]) {
      try {
        fn(reason);
      } catch {
        // 单个回调失败不得阻止其余回调
      }
    }
    this.handlers.clear();
  }
}

export function createCancelToken() {
  return new CancelToken();
}
