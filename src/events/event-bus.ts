/**
 * EventBus — typed pub/sub for system-wide communication.
 *
 * Two implementations:
 * - EventBus: simple, lightweight, no frills
 * - ManagedEventBus: filters, max invocations, subscription IDs, async emit
 */

import { randomBytes } from "node:crypto";
import type {
  Event,
  EventHandler,
  EventMap,
  Subscription,
  EventSubscription,
  EventBusInterface,
  EventFilter,
  SubscribeOptions,
} from "./types.js";

// ── Simple EventBus ─────────────────────────────────────────────────────────

export class EventBus implements EventBusInterface {
  private readonly handlers = new Map<string, Set<EventHandler<any>>>();

  subscribe<K extends keyof EventMap & string>(
    eventType: K,
    handler: EventHandler<EventMap[K]>,
  ): Subscription {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);
    return { unsubscribe: () => this.unsubscribe(eventType, handler) };
  }

  unsubscribe<K extends keyof EventMap & string>(
    eventType: K,
    handler: EventHandler<EventMap[K]>,
  ): void {
    const set = this.handlers.get(eventType);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.handlers.delete(eventType);
  }

  emit<K extends keyof EventMap & string>(
    eventType: K,
    data: EventMap[K],
    source?: string,
  ): void {
    const event: Event<EventMap[K]> = {
      type: eventType,
      data,
      timestamp: new Date().toISOString(),
      source,
    };

    this.dispatch(eventType, event);
    if (eventType !== "*") this.dispatch("*", event);
  }

  clear(eventType?: string): void {
    if (eventType) {
      this.handlers.delete(eventType);
    } else {
      this.handlers.clear();
    }
  }

  listenerCount(eventType: string): number {
    return this.handlers.get(eventType)?.size ?? 0;
  }

  private dispatch<T>(eventType: string, event: Event<T>): void {
    const handlers = this.handlers.get(eventType);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        const result = handler(event);
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch((err) => {
            console.error(`[EventBus] Error in async handler for "${event.type}":`, err);
          });
        }
      } catch (err) {
        console.error(`[EventBus] Error in handler for "${event.type}":`, err);
      }
    }
  }
}

// ── Managed EventBus ────────────────────────────────────────────────────────

interface InternalSubscription<T = unknown> {
  id: string;
  eventType: string;
  handler: EventHandler<T>;
  filter?: EventFilter<T>;
  label?: string;
  maxInvocations?: number;
  invocationCount: number;
  active: boolean;
}

export class ManagedEventBus implements EventBusInterface {
  private readonly subscriptions = new Map<string, InternalSubscription[]>();
  private readonly subscriptionIndex = new Map<string, InternalSubscription>();
  private errorHandler: ((eventType: string, error: unknown) => void) | null = null;

  subscribe<K extends keyof EventMap & string>(
    eventType: K,
    handler: EventHandler<EventMap[K]>,
    options?: SubscribeOptions<EventMap[K]>,
  ): EventSubscription {
    const sub: InternalSubscription<EventMap[K]> = {
      id: `sub_${Date.now()}_${randomBytes(4).toString("hex")}`,
      eventType,
      handler,
      filter: options?.filter,
      label: options?.label,
      maxInvocations: options?.maxInvocations,
      invocationCount: 0,
      active: true,
    };

    if (!this.subscriptions.has(eventType)) {
      this.subscriptions.set(eventType, []);
    }
    this.subscriptions.get(eventType)!.push(sub as InternalSubscription);
    this.subscriptionIndex.set(sub.id, sub as InternalSubscription);

    const self = this;
    return {
      id: sub.id,
      eventType,
      get active() { return sub.active; },
      unsubscribe() { self.removeSubscription(sub.id); },
    };
  }

  once<K extends keyof EventMap & string>(
    eventType: K,
    handler: EventHandler<EventMap[K]>,
    options?: Omit<SubscribeOptions<EventMap[K]>, "maxInvocations">,
  ): EventSubscription {
    return this.subscribe(eventType, handler, { ...options, maxInvocations: 1 });
  }

  unsubscribe<K extends keyof EventMap & string>(
    eventType: K,
    handler: EventHandler<EventMap[K]>,
  ): void {
    const subs = this.subscriptions.get(eventType);
    if (!subs) return;
    const idx = subs.findIndex((s) => s.handler === handler);
    if (idx !== -1) this.removeSubscription(subs[idx].id);
  }

  emit<K extends keyof EventMap & string>(
    eventType: K,
    data: EventMap[K],
    source?: string,
  ): void {
    const event: Event<EventMap[K]> = {
      type: eventType,
      data,
      timestamp: new Date().toISOString(),
      source,
    };
    this.dispatch(eventType, event);
    if (eventType !== "*") this.dispatch("*", event);
  }

  async emitAsync<K extends keyof EventMap & string>(
    eventType: K,
    data: EventMap[K],
    source?: string,
  ): Promise<void> {
    const event: Event<EventMap[K]> = {
      type: eventType,
      data,
      timestamp: new Date().toISOString(),
      source,
    };

    const promises = [
      ...this.dispatchAsync(eventType, event),
      ...(eventType !== "*" ? this.dispatchAsync("*", event) : []),
    ];

    const results = await Promise.allSettled(promises);
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => r.reason);

    if (errors.length > 0) {
      const err = new Error(`${errors.length} handler(s) failed for "${eventType}"`);
      (err as any).errors = errors;
      throw err;
    }
  }

  clear(eventType?: string): void {
    if (eventType) {
      const subs = this.subscriptions.get(eventType);
      if (subs) {
        for (const sub of subs) {
          sub.active = false;
          this.subscriptionIndex.delete(sub.id);
        }
        this.subscriptions.delete(eventType);
      }
    } else {
      for (const subs of this.subscriptions.values()) {
        for (const sub of subs) sub.active = false;
      }
      this.subscriptions.clear();
      this.subscriptionIndex.clear();
    }
  }

  listenerCount(eventType: string): number {
    return this.subscriptions.get(eventType)?.filter((s) => s.active).length ?? 0;
  }

  getSubscriptions(eventType?: string): readonly EventSubscription[] {
    const self = this;
    const source = eventType
      ? (this.subscriptions.get(eventType) ?? [])
      : Array.from(this.subscriptionIndex.values());

    return source.filter((s) => s.active).map((sub) => ({
      id: sub.id,
      eventType: sub.eventType,
      get active() { return sub.active; },
      unsubscribe() { self.removeSubscription(sub.id); },
    }));
  }

  onError(handler: (eventType: string, error: unknown) => void): void {
    this.errorHandler = handler;
  }

  destroy(): void {
    this.clear();
    this.errorHandler = null;
  }

  private dispatch<T>(eventType: string, event: Event<T>): void {
    const subs = this.subscriptions.get(eventType);
    if (!subs) return;

    const toRemove: string[] = [];
    for (const sub of subs) {
      if (!sub.active) continue;
      if (sub.filter && !sub.filter(event as Event<unknown>)) continue;
      if (sub.maxInvocations !== undefined && sub.invocationCount >= sub.maxInvocations) {
        toRemove.push(sub.id);
        continue;
      }

      sub.invocationCount++;
      try {
        const result = sub.handler(event as Event<unknown>);
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch((err) => this.handleError(event.type, err));
        }
      } catch (err) {
        this.handleError(event.type, err);
      }

      if (sub.maxInvocations !== undefined && sub.invocationCount >= sub.maxInvocations) {
        toRemove.push(sub.id);
      }
    }

    for (const id of toRemove) this.removeSubscription(id);
  }

  private dispatchAsync<T>(eventType: string, event: Event<T>): Promise<void>[] {
    const subs = this.subscriptions.get(eventType);
    if (!subs) return [];

    const promises: Promise<void>[] = [];
    const toRemove: string[] = [];

    for (const sub of subs) {
      if (!sub.active) continue;
      if (sub.filter && !sub.filter(event as Event<unknown>)) continue;
      if (sub.maxInvocations !== undefined && sub.invocationCount >= sub.maxInvocations) {
        toRemove.push(sub.id);
        continue;
      }

      sub.invocationCount++;
      promises.push((async () => { await sub.handler(event as Event<unknown>); })());
      if (sub.maxInvocations !== undefined && sub.invocationCount >= sub.maxInvocations) {
        toRemove.push(sub.id);
      }
    }

    for (const id of toRemove) this.removeSubscription(id);
    return promises;
  }

  private removeSubscription(id: string): void {
    const sub = this.subscriptionIndex.get(id);
    if (!sub) return;
    sub.active = false;
    this.subscriptionIndex.delete(id);
    const subs = this.subscriptions.get(sub.eventType);
    if (subs) {
      const idx = subs.findIndex((s) => s.id === id);
      if (idx !== -1) subs.splice(idx, 1);
      if (subs.length === 0) this.subscriptions.delete(sub.eventType);
    }
  }

  private handleError(eventType: string, err: unknown): void {
    if (this.errorHandler) {
      this.errorHandler(eventType, err);
    } else {
      console.error(`[ManagedEventBus] Error in handler for "${eventType}":`, err);
    }
  }
}
