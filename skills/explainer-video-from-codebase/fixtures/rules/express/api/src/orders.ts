export class OrderService {
  async get(id: string) {
    return this.load(id);
  }

  private load(id: string) {
    return { id, state: 'open' };
  }
}
