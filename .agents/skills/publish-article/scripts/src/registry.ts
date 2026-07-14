import { PublishError } from "./errors";
import type { PublisherEndpoint } from "./types";

export type EndpointFactory = () => PublisherEndpoint;

export class PublisherRegistry {
  readonly #factories = new Map<string, EndpointFactory>();

  register(id: string, factory: EndpointFactory): this {
    if (!id || this.#factories.has(id)) {
      throw new PublishError("E_ENDPOINT_REGISTRATION", `Endpoint already registered or invalid: ${id}`);
    }
    this.#factories.set(id, factory);
    return this;
  }

  resolve(id: string): PublisherEndpoint {
    const factory = this.#factories.get(id);
    if (!factory) throw new PublishError("E_ENDPOINT_UNKNOWN", `Unknown endpoint: ${id}`);
    const endpoint = factory();
    if (endpoint.id !== id) {
      throw new PublishError("E_ENDPOINT_ID", `Endpoint factory ${id} returned ${endpoint.id}`);
    }
    return endpoint;
  }

  list(): string[] {
    return [...this.#factories.keys()].sort();
  }
}
