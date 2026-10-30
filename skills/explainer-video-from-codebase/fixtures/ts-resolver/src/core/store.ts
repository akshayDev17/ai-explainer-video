export abstract class Store {
  abstract load(key: string): string;

  save(key: string) {
    this.log(key);
    this.write(key);
  }

  protected write(key: string) {
    return key;
  }

  private log(key: string) {
    return key;
  }
}

export class MemoryStore extends Store {
  load(key: string) {
    return `mem:${key}`;
  }

  protected write(key: string) {
    return super.write(key);
  }
}

export class RedisStore extends Store {
  load(key: string) {
    return `redis:${key}`;
  }
}
