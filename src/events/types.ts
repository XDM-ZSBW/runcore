/**
 * Core event system type definitions.
 *
 * Provides typed pub/sub primitives for system-wide event communication.
 */

/** Base event structure. All events flowing through the bus carry this shape. */
export interface Event<T = unknown> {
  /** Event type identifier (e.g. "memory:learned", "agent:spawned"). */
  type: string;
  /** Event payload. */
  data: T;
  /** ISO-8601 timestamp of when the event was created. */
  timestamp: string;
  /** Optional source identifier (agent ID, module name, etc.). */
  source?: string;
}

/** Handler function for processing events. Supports async handlers. */
export type EventHandler<T = unknown> = (event: Event<T>) => void | Promise<void>;

/**
 * Event type map — extend this interface to register typed events.
 *
 * Example:
 * ```ts
 * declare module "./types.js" {
 *   interface EventMap {
 *     "memory:learned": { content: string; type: string };
 *     "agent:spawned": { agentId: string; pid?: number };
 *   }
 * }
 * ```
 */
export interface EventMap {
  [eventType: string]: unknown;
}

/** Subscription handle returned by subscribe(), used for unsubscription. */
export interface Subscription {
  /** Remove this subscription. */
  unsubscribe(): void;
}

/** Extended subscription with metadata and status tracking. */
export interface EventSubscription extends Subscription {
  /** Unique subscription ID. */
  readonly id: string;
  /** The event type this subscription listens to. */
  readonly eventType: string;
  /** Whether this subscription is still active. */
  readonly active: boolean;
}

/** Filter predicate applied before handler invocation. */
export type EventFilter<T = unknown> = (event: Event<T>) => boolean;

/** Options for subscribing with filtering and lifecycle controls. */
export interface SubscribeOptions<T = unknown> {
  /** Only invoke handler when filter returns true. */
  filter?: EventFilter<T>;
  /** Automatically unsubscribe after this many invocations. */
  maxInvocations?: number;
  /** Optional label for debugging/inspection. */
  label?: string;
}

/** Core event bus contract. */
export interface EventBusInterface {
  /** Subscribe to an event type. Returns a subscription handle. */
  subscribe<K extends keyof EventMap & string>(
    eventType: K,
    handler: EventHandler<EventMap[K]>,
  ): Subscription;

  /** Remove a specific handler for an event type. */
  unsubscribe<K extends keyof EventMap & string>(
    eventType: K,
    handler: EventHandler<EventMap[K]>,
  ): void;

  /** Emit an event to all subscribers of its type. */
  emit<K extends keyof EventMap & string>(
    eventType: K,
    data: EventMap[K],
    source?: string,
  ): void;

  /** Remove all handlers for a given event type, or all handlers if no type specified. */
  clear(eventType?: string): void;
}
