export interface Endpoint {
  name: string;
  base_url: string;
  api_key: string;
  model: string;
}

/** Round-robin endpoint rotation with cooldown on failure */
export class EndpointRotator {
  private endpoints: Endpoint[];
  private index = 0;
  private cooldowns = new Map<number, number>();
  private cooldownMs = 60_000;

  constructor(endpoints: Endpoint[]) {
    this.endpoints = endpoints.filter(e => e.api_key);
  }

  next(): Endpoint {
    if (!this.endpoints.length) throw new Error("No endpoints configured");
    const now = Date.now();
    const len = this.endpoints.length;
    for (let i = 0; i < len; i++) {
      const idx = (this.index + i) % len;
      if ((this.cooldowns.get(idx) || 0) <= now) {
        this.index = (idx + 1) % len;
        return this.endpoints[idx];
      }
    }
    const idx = this.index;
    this.index = (idx + 1) % len;
    return this.endpoints[idx];
  }

  markFailed(ep: Endpoint): void {
    const idx = this.endpoints.indexOf(ep);
    if (idx >= 0) this.cooldowns.set(idx, Date.now() + this.cooldownMs);
  }

  get count(): number {
    return this.endpoints.length;
  }

  list(): { name: string; model: string }[] {
    return this.endpoints.map(e => ({ name: e.name, model: e.model }));
  }

  reload(endpoints: Endpoint[]) {
    this.endpoints = endpoints.filter(e => e.api_key);
    this.index = 0;
    this.cooldowns.clear();
  }
}
