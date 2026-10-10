import * as path from 'path';
import { Worker } from 'worker_threads';
import type { FormatJob, FormatResult } from './format-job';

interface WorkerLike {
  on(event: string, callback: (...args: any[]) => void): this;
  postMessage(message: unknown): void;
  terminate(): Promise<number>;
  ref(): void;
  unref(): void;
}

interface Request {
  id: number;
  key: string;
  job: FormatJob;
  resolve: (result: FormatResult | undefined) => void;
  reject: (error: Error) => void;
}

/** One persistent formatter. A newer request replaces obsolete work for the
 * same document. Terminating a running canceled job interrupts CPU work too.
 */
export class FormatterWorker {
  private worker?: WorkerLike;
  private ready = false;
  private active?: Request;
  private queue: Request[] = [];
  private nextId = 0;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(
    private createWorker: () => WorkerLike = () =>
      new Worker(path.join(__dirname, 'formatter-worker.js'))
  ) {}

  request(key: string, job: FormatJob) {
    const id = ++this.nextId;
    const promise = new Promise<FormatResult | undefined>((resolve, reject) => {
      if (this.disposed) {
        resolve(undefined);
        return;
      }
      for (const old of [...this.queue]) {
        if (old.key === key) {
          this.cancel(old.id);
        }
      }
      if (this.active?.key === key) {
        this.cancel(this.active.id);
      }
      this.queue.push({ id, key, job: this.serializableJob(job), resolve, reject });
      this.pump();
    });
    return { promise, cancel: () => this.cancel(id) };
  }

  private serializableJob(job: FormatJob): FormatJob {
    // CLJS maps are reconstructed from their original EDN in the worker.
    const config = { ...job.config };
    if (config['cljfmt-options-string']) {
      delete config['cljfmt-options'];
    }
    return { ...job, config };
  }

  private cancel(id: number) {
    const queued = this.queue.findIndex((request) => request.id === id);
    if (queued !== -1) {
      this.queue.splice(queued, 1)[0].resolve(undefined);
    } else if (this.active?.id === id) {
      const active = this.active;
      this.active = undefined;
      this.stopWorker();
      active.resolve(undefined);
      this.pump();
    }
  }

  private pump() {
    if (this.disposed || this.active || !this.queue.length) {
      if (!this.active && !this.queue.length) {
        this.worker?.unref();
      }
      return;
    }
    if (!this.worker) {
      try {
        const worker = this.createWorker();
        this.worker = worker;
        this.ready = false;
        worker.on('message', (message) => {
          if (this.worker !== worker) {
            return;
          }
          if (message.ready) {
            clearTimeout(this.startupTimer);
            this.ready = true;
            this.pump();
          } else if (this.active && message.id === this.active.id) {
            const active = this.active;
            this.active = undefined;
            if (message.error) {
              active.reject(new Error(message.error));
            } else {
              active.resolve(message.result);
            }
            this.pump();
          }
        });
        worker.on('error', (error) => this.fail(worker, error));
        worker.on('exit', (code) =>
          this.fail(worker, new Error(`Formatter worker exited (${code})`))
        );
        this.startupTimer = setTimeout(
          () => this.fail(worker, new Error('Formatter worker startup timed out')),
          15000
        );
      } catch (error) {
        this.fail(undefined, error);
        return;
      }
    }
    this.worker.ref();
    if (!this.ready) {
      return;
    }
    this.active = this.queue.shift();
    try {
      this.worker.postMessage({ id: this.active.id, job: this.active.job });
    } catch (error) {
      this.fail(this.worker, error);
    }
  }

  private fail(worker: WorkerLike | undefined, error: Error) {
    if (this.worker !== worker) {
      return;
    }
    const pending = [...(this.active ? [this.active] : []), ...this.queue];
    this.active = undefined;
    this.queue = [];
    this.stopWorker();
    pending.forEach((request) => request.reject(error));
  }

  private stopWorker() {
    clearTimeout(this.startupTimer);
    const worker = this.worker;
    this.worker = undefined;
    this.ready = false;
    if (worker) {
      void worker.terminate().catch(() => undefined);
    }
  }

  dispose() {
    this.disposed = true;
    const pending = [...(this.active ? [this.active] : []), ...this.queue];
    this.active = undefined;
    this.queue = [];
    this.stopWorker();
    pending.forEach((request) => request.resolve(undefined));
  }
}

export const formatterWorker = new FormatterWorker();
