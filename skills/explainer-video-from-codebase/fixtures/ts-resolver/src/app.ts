import { MemoryStore, Store, Log, makeStore } from '@core/index';
import { logger } from '@core/log';
import * as util from './util.js';
import { shared } from '@acme/shared';

export class App {
  constructor(private readonly store: Store, private log = new Log()) {}

  run(key: string) {
    this.store.save(key);
    logger.info(key);
    util.format(key);
    this.log.info(key);
    return this.store.load(key);
  }
}

export function boot() {
  const s = makeStore();
  s.load('x');
  const app = new App(new MemoryStore());
  try {
    app.run(shared('a'));
  } catch (e) {
    report(e);
  }
}

function report(e: unknown) {
  return String(e);
}

const api = {
  ping() {
    return util.format('p');
  },
};

export function callApi() {
  return api.ping();
}

export function scheduled() {
  util.retry(boot);
}
