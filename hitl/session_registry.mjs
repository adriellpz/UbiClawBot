export class SessionRegistry {
  #counter = 0;
  #sessions = new Map();

  assign(context) {
    const n = ++this.#counter;
    this.#sessions.set(n, { ...context, n });
    return n;
  }

  resolve(n) {
    const session = this.#sessions.get(n);
    if (!session) return;
    this.#sessions.delete(n);
    session.resolve?.();
  }

  get(n) {
    return this.#sessions.get(n);
  }
}
