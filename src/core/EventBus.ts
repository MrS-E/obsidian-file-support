import type { FileSupportEventMap } from "../types/contracts";

export type NextFn = () => Promise<void>;

export type EventHandler<TPayload> = (payload: TPayload) => Promise<void> | void;

export type ScopedMiddleware<TPayload> = (
  payload: TPayload,
  next: NextFn
) => Promise<void> | void;

export type GlobalMiddleware<TEventMap extends Record<string, any>> = <
  K extends keyof TEventMap & string
>(
  event: K,
  payload: TEventMap[K],
  next: NextFn
) => Promise<void> | void;

export type UnsubscribeFn = () => void;

interface MiddlewareEntry<TEventMap extends Record<string, any>> {
  event?: keyof TEventMap & string;
  fn: ScopedMiddleware<any> | GlobalMiddleware<TEventMap>;
  isGlobal: boolean;
}

/**
 * Typed pub/sub and middleware pipeline event bus.
 * Supports ordered async/sync middlewares (`use`), subscribers (`on`, `once`, `off`), and `emit`.
 */
export class EventBus<
  TEventMap extends Record<string, any> = FileSupportEventMap
> {
  private listeners: Map<keyof TEventMap & string, Set<EventHandler<any>>> =
    new Map();
  private middlewares: MiddlewareEntry<TEventMap>[] = [];

  /**
   * Subscribe a listener to a specific event.
   * Listeners execute after all middlewares for the event call `next()`.
   */
  on<K extends keyof TEventMap & string>(
    event: K,
    handler: EventHandler<TEventMap[K]>
  ): UnsubscribeFn {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return () => {
      this.off(event, handler);
    };
  }

  /**
   * Subscribe a one-time listener to a specific event.
   */
  once<K extends keyof TEventMap & string>(
    event: K,
    handler: EventHandler<TEventMap[K]>
  ): UnsubscribeFn {
    const wrapper: EventHandler<TEventMap[K]> = async (payload) => {
      this.off(event, wrapper);
      await handler(payload);
    };
    return this.on(event, wrapper);
  }

  /**
   * Remove a previously registered listener for a specific event.
   */
  off<K extends keyof TEventMap & string>(
    event: K,
    handler: EventHandler<TEventMap[K]>
  ): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) {
      this.listeners.delete(event);
    }
  }

  /**
   * Register an event-scoped middleware or a global middleware in the pipeline.
   * Middlewares run in registration order before `on` subscribers.
   * Skipping `await next()` short-circuits downstream middlewares and subscribers.
   */
  use<K extends keyof TEventMap & string>(
    event: K,
    middleware: ScopedMiddleware<TEventMap[K]>
  ): UnsubscribeFn;
  use(middleware: GlobalMiddleware<TEventMap>): UnsubscribeFn;
  use<K extends keyof TEventMap & string>(
    eventOrMiddleware: K | GlobalMiddleware<TEventMap>,
    maybeMiddleware?: ScopedMiddleware<TEventMap[K]>
  ): UnsubscribeFn {
    let entry: MiddlewareEntry<TEventMap>;

    if (typeof eventOrMiddleware === "function") {
      entry = {
        fn: eventOrMiddleware,
        isGlobal: true,
      };
    } else {
      if (typeof maybeMiddleware !== "function") {
        throw new TypeError(
          `Middleware for event "${String(eventOrMiddleware)}" must be a function.`
        );
      }
      entry = {
        event: eventOrMiddleware,
        fn: maybeMiddleware,
        isGlobal: false,
      };
    }

    this.middlewares.push(entry);

    return () => {
      const idx = this.middlewares.indexOf(entry);
      if (idx !== -1) {
        this.middlewares.splice(idx, 1);
      }
    };
  }

  /**
   * Emit an event through the middleware pipeline and then to all registered listeners.
   * Resolves with the (potentially middleware-enriched) payload.
   */
  async emit<K extends keyof TEventMap & string>(
    event: K,
    payload: TEventMap[K]
  ): Promise<TEventMap[K]> {
    const applicableMiddlewares = this.middlewares.filter(
      (m) => m.isGlobal || m.event === event
    );

    const handlers = Array.from(this.listeners.get(event) ?? []);

    let index = -1;

    const dispatch = async (i: number): Promise<void> => {
      if (i <= index) {
        throw new Error("next() called multiple times in EventBus middleware");
      }
      index = i;

      if (i < applicableMiddlewares.length) {
        const entry = applicableMiddlewares[i];
        const next: NextFn = () => dispatch(i + 1);
        if (entry.isGlobal) {
          await (entry.fn as GlobalMiddleware<TEventMap>)(event, payload, next);
        } else {
          await (entry.fn as ScopedMiddleware<TEventMap[K]>)(payload, next);
        }
        return;
      }

      if (i === applicableMiddlewares.length) {
        for (const handler of handlers) {
          await handler(payload);
        }
      }
    };

    await dispatch(0);
    return payload;
  }

  /**
   * Return the number of active listeners for a given event.
   */
  listenerCount<K extends keyof TEventMap & string>(event: K): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  /**
   * Return the number of registered middlewares (optionally filtered by event).
   */
  middlewareCount<K extends keyof TEventMap & string>(event?: K): number {
    if (!event) {
      return this.middlewares.length;
    }
    return this.middlewares.filter((m) => m.isGlobal || m.event === event)
      .length;
  }

  /**
   * Remove all listeners and middlewares.
   */
  clear(): void {
    this.listeners.clear();
    this.middlewares = [];
  }
}

export { EventBus as FileSupportEventBus };
