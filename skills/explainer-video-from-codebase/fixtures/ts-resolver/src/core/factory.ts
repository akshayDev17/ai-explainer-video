import { MemoryStore, RedisStore, Store } from './store';

export default function makeStore(): Store {
  if (process.env.STORE === 'redis') {
    return new RedisStore();
  }
  return new MemoryStore();
}
