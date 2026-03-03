/**
 * Agent Runtime Environment — Inter-agent event bus.
 *
 * EventEmitter-based pub/sub with typed events, message routing,
 * and request/response correlation patterns.
 */

import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import type { AgentMessage, RuntimeEvents, LifecycleEvent, AgentError, ResourceSnapshot } from "./types.js";

// ---------------------------------------------------------------------------
// Typed event bus
// ---------------------------------------------------------------------------

type EventHandler<T> = (data: T) => void | Promise<void>;

export class RuntimeBus {
  private readonly emitter = new EventEmitter();

  /** Pending request/response callbacks keyed by correlationId. */
  private readonly pendingRequests = new Map<
    string,
    {
      resolve: (msg: AgentMessage) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  /** Per-agent message subscriptions. */
  private readonly agentSubscriptions = new Map<string, Set<string>>();

  constructor() {
    // Prevent memory leak warnings for many agent listeners
    this.emitter.setMaxListeners(200);
  }

  // -------------------------------------------------------------------------
  // Typed pub/sub for runtime events
  // -------------------------------------------------------------------------

  on<K extends keyof RuntimeEvents>(event: K, handler: EventHandler<RuntimeEvents[K]>): void {
    this.emitter.on(event, handler as (...args: unknown[]) => void);
  }

  off<K extends keyof RuntimeEvents>(event: K, handler: EventHandler<RuntimeEvents[K]>): void {
    this.emitter.off(event, handler as (...args: unknown[]) => void);
  }

  once<K extends keyof RuntimeEvents>(event: K, handler: EventHandler<RuntimeEvents[K]>): void {
    this.emitter.once(event, handler as (...args: unknown[]) => void);
  }

  emit<K extends keyof RuntimeEvents>(event: K, data: RuntimeEvents[K]): void {
    this.emitter.emit(event, data);
  }

  // -------------------------------------------------------------------------
  // Inter-agent messaging
  // -------------------------------------------------------------------------

  /** Send a message to a specific agent or broadcast to all. */
  send(message: Omit<AgentMessage, "id" | "timestamp">): AgentMessage {
    const full: AgentMessage = {
      ...message,
      id: generateMessageId(),
      timestamp: new Date().toISOString(),
    };

    // Check if this is a response to a pending request
    if (full.correlationId && this.pendingRequests.has(full.correlationId)) {
      const pending = this.pendingRequests.get(full.correlationId)!;
      this.pendingRequests.delete(full.correlationId);
      clearTimeout(pending.timer);
      pending.resolve(full);
    }

    // Emit on the bus for listeners
    this.emit("agent:message", full);

    return full;
  }

  /**
   * Send a request and wait for a correlated response.
   * Times out after timeoutMs (default 30s).
   */
  request(
    message: Omit<AgentMessage, "id" | "timestamp" | "correlationId">,
    timeoutMs: number = 30_000,
  ): Promise<AgentMessage> {
    const correlationId = generateMessageId();

    return new Promise<AgentMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(correlationId);
        reject(new Error(`Request to ${message.to} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(correlationId, { resolve, reject, timer });

      // Emit the outbound request directly instead of using send() to avoid
      // send()'s correlationId check resolving the pending request immediately
      const outbound: AgentMessage = {
        ...message,
        correlationId,
        id: generateMessageId(),
        timestamp: new Date().toISOString(),
      };
      this.emit("agent:message", outbound);
    });
  }

  /**
   * Subscribe an agent to receive messages. When a message is sent to
   * this agent's ID (or broadcast to "*"), the handler is called.
   */
  subscribe(agentId: string, handler: EventHandler<AgentMessage>): void {
    if (!this.agentSubscriptions.has(agentId)) {
      this.agentSubscriptions.set(agentId, new Set());
    }

    const wrappedHandler = (msg: AgentMessage) => {
      if (msg.to === agentId || msg.to === "*") {
        // Skip expired messages
        if (msg.ttlMs) {
          const age = Date.now() - new Date(msg.timestamp).getTime();
          if (age > msg.ttlMs) return;
        }
        handler(msg);
      }
    };

    // Store a key for the handler so we can clean up
    const handlerKey = `msg:${agentId}`;
    this.emitter.on(handlerKey, wrappedHandler);
    this.agentSubscriptions.get(agentId)!.add(handlerKey);

    // Also listen to the global agent:message topic for routing
    const globalHandler = (msg: AgentMessage) => {
      if (msg.to === agentId || msg.to === "*") {
        if (msg.ttlMs) {
          const age = Date.now() - new Date(msg.timestamp).getTime();
          if (age > msg.ttlMs) return;
        }
        handler(msg);
      }
    };

    this.emitter.on("agent:message", globalHandler);
    // Store cleanup ref
    (this.agentSubscriptions.get(agentId) as Set<string>).add(
      `cleanup:${agentId}:${Date.now()}`,
    );
    // Store actual handler ref for cleanup
    this._globalHandlers.set(agentId, globalHandler);
  }

  // Store global handlers for cleanup
  private _globalHandlers = new Map<string, EventHandler<AgentMessage>>();

  /** Unsubscribe an agent from all messages. */
  unsubscribe(agentId: string): void {
    const handler = this._globalHandlers.get(agentId);
    if (handler) {
      this.emitter.off("agent:message", handler as (...args: unknown[]) => void);
      this._globalHandlers.delete(agentId);
    }
    this.agentSubscriptions.delete(agentId);
  }

  // -------------------------------------------------------------------------
  // Lifecycle event helpers
  // -------------------------------------------------------------------------

  emitLifecycle(event: LifecycleEvent): void {
    this.emit("agent:lifecycle", event);
  }

  emitError(agentId: string, error: AgentError): void {
    this.emit("agent:error", { agentId, error });
  }

  emitSpawned(agentId: string, pid?: number): void {
    this.emit("agent:spawned", { agentId, pid });
  }

  emitCompleted(agentId: string, exitCode?: number): void {
    this.emit("agent:completed", { agentId, exitCode });
  }

  emitFailed(agentId: string, error: AgentError): void {
    this.emit("agent:failed", { agentId, error });
  }

  emitResourceWarning(usage: ResourceSnapshot): void {
    this.emit("runtime:resource-warning", { usage });
  }

  emitShutdown(reason: string): void {
    this.emit("runtime:shutdown", { reason });
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /** Clear all listeners and pending requests. For shutdown. */
  destroy(): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Bus destroyed"));
    }
    this.pendingRequests.clear();
    this._globalHandlers.clear();
    this.agentSubscriptions.clear();
    this.emitter.removeAllListeners();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateMessageId(): string {
  return `msg_${Date.now()}_${randomBytes(4).toString("hex")}`;
}
