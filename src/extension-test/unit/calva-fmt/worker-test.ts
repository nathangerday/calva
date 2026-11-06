import * as assert from 'assert';
import { EventEmitter } from 'events';
import { FormatterWorker } from '../../../calva-fmt/src/worker-client';
import { FormatJob, runFormatJob } from '../../../calva-fmt/src/format-job';
import * as model from '../../../cursor-doc/model';

class FakeWorker extends EventEmitter {
  sent: { id: number; job: FormatJob }[] = [];
  terminated = false;
  referenced = false;
  postMessage(message) {
    this.sent.push(message);
  }
  terminate() {
    this.terminated = true;
    return Promise.resolve(0);
  }
  ref() {
    this.referenced = true;
  }
  unref() {
    this.referenced = false;
  }
  complete() {
    const { id, job } = this.sent[this.sent.length - 1];
    this.emit('message', { id, result: runFormatJob(job) });
  }
}

const job: FormatJob = {
  kind: 'range',
  text: '(ns test (:require [z] [a]))\n(defn f [x]\n(+ x 1))',
  range: [0, 54],
  indexes: [],
  eol: '\n',
  onType: false,
  startColumn: 0,
  fullDocument: true,
  scannerMaxLength: 20000,
  config: { 'cljfmt-options-string': '{:sort-ns-references? true :indents {#"^f$" [[:inner 0]]}}' },
};

model.initScanner(20000);
describe('Formatter worker scheduling', () => {
  let workers: FakeWorker[];
  let client: FormatterWorker;
  beforeEach(() => {
    workers = [];
    client = new FormatterWorker(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
  });
  afterEach(() => client.dispose());

  it('coalesces queued document requests and reuses the idle worker', async () => {
    const old = client.request('a', job);
    const newest = client.request('a', job);
    const other = client.request('b', job);
    assert.strictEqual(await old.promise, undefined);
    assert.strictEqual(workers.length, 1);
    workers[0].emit('message', { ready: true });
    assert.strictEqual(workers[0].sent.length, 1);
    workers[0].complete();
    assert.deepStrictEqual(await newest.promise, runFormatJob(job));
    workers[0].complete();
    await other.promise;
    assert.strictEqual(workers[0].referenced, false);
    const later = client.request('c', job);
    assert.strictEqual(workers.length, 1);
    workers[0].complete();
    await later.promise;
  });

  it('interrupts a running cancellation and ignores old worker events', async () => {
    const active = client.request('a', job);
    workers[0].emit('message', { ready: true });
    const queued = client.request('b', job);
    active.cancel();
    assert.strictEqual(await active.promise, undefined);
    assert.strictEqual(workers[0].terminated, true);
    assert.strictEqual(workers.length, 2);
    workers[0].complete();
    workers[0].emit('exit', 1);
    workers[0].emit('error', new Error('late error'));
    workers[1].emit('message', { ready: true });
    workers[1].complete();
    assert.deepStrictEqual(await queued.promise, runFormatJob(job));
  });

  it('cancels queued work without interrupting another document', async () => {
    const active = client.request('a', job);
    workers[0].emit('message', { ready: true });
    const queued = client.request('b', job);
    queued.cancel();
    assert.strictEqual(await queued.promise, undefined);
    assert.strictEqual(workers[0].terminated, false);
    workers[0].complete();
    await active.promise;
  });

  it('rejects outstanding work on crash and permits a fresh request', async () => {
    const active = client.request('a', job);
    const queued = client.request('b', job);
    const checked = Promise.all([
      assert.rejects(active.promise, /crash/),
      assert.rejects(queued.promise, /crash/),
    ]);
    workers[0].emit('error', new Error('crash'));
    await checked;
    const fresh = client.request('c', job);
    workers[1].emit('message', { ready: true });
    workers[1].complete();
    await fresh.promise;
  });

  it('settles pending requests on dispose and refuses subsequent work', async () => {
    const active = client.request('a', job);
    client.dispose();
    assert.strictEqual(await active.promise, undefined);
    assert.strictEqual(await client.request('b', job).promise, undefined);
  });
});
