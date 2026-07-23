import type { Event } from "@space/contracts";

export type EventSubscriber = (event: Event) => void;
export type EventSubscriberErrorHandler = (error: unknown, event: Event) => void;

export interface SpaceEventBusOptions {
  onSubscriberError?: EventSubscriberErrorHandler;
}

export class SpaceEventBus {
  private subscribers = new Set<EventSubscriber>();

  constructor(private readonly options: SpaceEventBusOptions = {}) {}

  subscribe(subscriber: EventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  publish(event: Event): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch (error) {
        try {
          this.options.onSubscriberError?.(error, event);
        } catch {
          // Error reporting must not prevent delivery to the remaining subscribers.
        }
      }
    }
  }
}
