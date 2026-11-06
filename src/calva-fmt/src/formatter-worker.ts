import { parentPort } from 'worker_threads';
import { initScanner } from '../../cursor-doc/model';
import { FormatJob, runFormatJob } from './format-job';

parentPort.on('message', ({ id, job }: { id: number; job: FormatJob }) => {
  try {
    initScanner(job.scannerMaxLength);
    parentPort.postMessage({ id, result: runFormatJob(job) });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.stack ?? error) });
  }
});
parentPort.postMessage({ ready: true });
