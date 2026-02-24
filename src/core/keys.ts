import type { Endpoint } from "./config.js";

/** Simple round-robin endpoint selector — CLI handles its own auth */
export class EndpointRotator {
  private endpoints: Endpoint[];
  private index = 0;

  constructor(endpoints: Endpoint[]) {
    this.endpoints = endpoints;
  }

  next(): Endpoint {
    if (!this.endpoints.length) throw new Error("No endpoints configured");
    const idx = this.index % this.endpoints.length;
    this.index = (idx + 1) % this.endpoints.length;
    return this.endpoints[idx];
  }

  get count(): number {
    return this.endpoints.length;
  }

  list(): { name: string; model: string }[] {
    return this.endpoints.map(e => ({ name: e.name, model: e.model }));
  }

  reload(endpoints: Endpoint[]) {
    this.endpoints = endpoints;
    this.index = 0;
  }
}
