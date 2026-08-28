import { Awaitable, defineProperty, Promisify, remove } from 'cosmokit'
import { Context } from './context.ts'
import { EffectScope, ForkScope, MainScope, ScopeStatus } from './scope.ts'
import { getTraceable, symbols } from './index.ts'
import ReflectService from './reflect.ts'

/**
 * Determine whether an event listener's return value qualifies as a "bailed" result.
 *
 * In Cordis, an event bails (halts subsequent listeners) when a listener returns any value
 * other than `null`, `false`, or `undefined`.
 *
 * @param value The return value to test.
 * @returns `true` if the return value is non-bail (i.e. truthy or a defined object/primitive other than false).
 */
export function isBailed(value: any) {
  return value !== null && value !== false && value !== undefined
}

/** Extract parameter types of a function. */
export type Parameters<F> = F extends (...args: infer P) => any ? P : never
/** Extract return type of a function. */
export type ReturnType<F> = F extends (...args: any) => infer R ? R : never
/** Extract explicit `this` type of a function. */
export type ThisType<F> = F extends (this: infer T, ...args: any) => any ? T : never
/** Extract the Events interface map associated with Context `C`. */
export type GetEvents<C extends Context> = C[typeof Context.events]

declare module './context.ts' {
  export interface Context {
    /* eslint-disable max-len */
    /** Mapping of event names to listener signatures. */
    [Context.events]: Events<this>

    /**
     * Dispatch an event in parallel to all registered listeners and await all returned promises.
     *
     * @param name Event name.
     * @param args Arguments passed to listeners.
     */
    parallel<K extends keyof GetEvents<this>>(name: K, ...args: Parameters<GetEvents<this>[K]>): Promise<void>
    parallel<K extends keyof GetEvents<this>>(thisArg: ThisType<GetEvents<this>[K]>, name: K, ...args: Parameters<GetEvents<this>[K]>): Promise<void>

    /**
     * Dispatch an event synchronously to all registered listeners.
     *
     * @param name Event name.
     * @param args Arguments passed to listeners.
     */
    emit<K extends keyof GetEvents<this>>(name: K, ...args: Parameters<GetEvents<this>[K]>): void
    emit<K extends keyof GetEvents<this>>(thisArg: ThisType<GetEvents<this>[K]>, name: K, ...args: Parameters<GetEvents<this>[K]>): void

    /**
     * Dispatch an event asynchronously in serial order, returning the first non-bailed result.
     *
     * @param name Event name.
     * @param args Arguments passed to listeners.
     */
    serial<K extends keyof GetEvents<this>>(name: K, ...args: Parameters<GetEvents<this>[K]>): Promisify<ReturnType<GetEvents<this>[K]>>
    serial<K extends keyof GetEvents<this>>(thisArg: ThisType<GetEvents<this>[K]>, name: K, ...args: Parameters<GetEvents<this>[K]>): Promisify<ReturnType<GetEvents<this>[K]>>

    /**
     * Dispatch an event synchronously in serial order, returning the first non-bailed result.
     *
     * @param name Event name.
     * @param args Arguments passed to listeners.
     */
    bail<K extends keyof GetEvents<this>>(name: K, ...args: Parameters<GetEvents<this>[K]>): ReturnType<GetEvents<this>[K]>
    bail<K extends keyof GetEvents<this>>(thisArg: ThisType<GetEvents<this>[K]>, name: K, ...args: Parameters<GetEvents<this>[K]>): ReturnType<GetEvents<this>[K]>

    /**
     * Register an event listener in the current context scope.
     * The listener will be automatically unregistered when this context's scope is disposed.
     *
     * @param name Event name.
     * @param listener The listener callback.
     * @param options Registration options (e.g. `prepend`, `global`).
     * @returns A disposable function to unregister the listener.
     */
    on<K extends keyof GetEvents<this>>(name: K, listener: GetEvents<this>[K], options?: boolean | EventOptions): () => boolean

    /**
     * Register a one-time event listener in the current context scope.
     * Automatically unregisters itself after firing once.
     *
     * @param name Event name.
     * @param listener The listener callback.
     * @param options Registration options.
     * @returns A disposable function to unregister the listener early.
     */
    once<K extends keyof GetEvents<this>>(name: K, listener: GetEvents<this>[K], options?: boolean | EventOptions): () => boolean

    /**
     * Remove a previously registered event listener.
     *
     * @param name Event name.
     * @param listener The listener function reference to remove.
     * @returns `true` if a listener was removed, `false` otherwise.
     */
    off<K extends keyof GetEvents<this>>(name: K, listener: GetEvents<this>[K]): boolean

    /**
     * Start the lifecycle and trigger all registered `'ready'` event listeners.
     */
    start(): Promise<void>

    /**
     * Stop the lifecycle and reset all active context scopes.
     */
    stop(): Promise<void>
    /* eslint-enable max-len */
  }
}

/**
 * Options for registering event listeners.
 */
export interface EventOptions {
  /**
   * If `true`, add the listener to the beginning of the listener array (executed first).
   */
  prepend?: boolean
  /**
   * If `true`, bypass context filter checks and execute for events dispatched from any context.
   */
  global?: boolean
}

/**
 * Internal descriptor representing a registered event listener hook.
 */
export interface Hook extends EventOptions {
  /** The context where the hook was registered. */
  ctx: Context
  /** The hook callback function. */
  callback: (...args: any[]) => any
}

/**
 * Lifecycle manages event dispatching, listener registries, and application startup/shutdown.
 */
class Lifecycle {
  /** Whether the lifecycle has been started via `start()`. */
  isActive = false
  /** Set of pending asynchronous lifecycle tasks. */
  _tasks = new Set<Promise<void>>()
  /** Internal map storing registered hooks keyed by event name. */
  _hooks: Record<keyof any, Hook[]> = {}

  /**
   * Create a new Lifecycle instance.
   *
   * @param ctx The context bound to this lifecycle manager.
   */
  constructor(private ctx: Context) {
    defineProperty(this, symbols.tracker, {
      associate: 'lifecycle',
      property: 'ctx',
    })

    // Special event listener interceptor
    defineProperty(this.on('internal/listener', function (this: Context, name, listener, options: EventOptions) {
      const method = options.prepend ? 'unshift' : 'push'
      if (name === 'ready') {
        if (!this.lifecycle.isActive) return
        this.scope.ensure(async () => listener())
        return () => false
      } else if (name === 'dispose') {
        this.scope.disposables[method](listener as any)
        defineProperty(listener, 'name', 'event <dispose>')
        return () => remove(this.scope.disposables, listener)
      } else if (name === 'fork') {
        this.scope.runtime.forkables[method](listener as any)
        return this.scope.collect('event <fork>', () => remove(this.scope.runtime.forkables, listener))
      }
    }), Context.static, ctx.scope)

    // Default console logging handlers for internal messages if no custom handlers exist
    for (const level of ['info', 'error', 'warning']) {
      defineProperty(this.on(`internal/${level}`, (format, ...param) => {
        if (this._hooks[`internal/${level}`].length > 1) return
        // eslint-disable-next-line no-console
        console.info(format, ...param)
      }), Context.static, ctx.scope)
    }

    // Reactive service dependency listener: reset scopes when required service is removed/updated
    // non-reusable plugin forks are not responsive to isolated service changes
    defineProperty(this.on('internal/before-service', function (this: Context, name) {
      for (const runtime of this.registry.values()) {
        if (!runtime.inject[name]?.required) continue
        const scopes = runtime.isReusable ? runtime.children : [runtime]
        for (const scope of scopes) {
          if (!this[symbols.filter](scope.ctx)) continue
          scope.updateStatus()
          scope.reset()
        }
      }
    }, { global: true }), Context.static, ctx.scope)

    // Reactive service dependency listener: start scopes when required service becomes available
    defineProperty(this.on('internal/service', function (this: Context, name) {
      for (const runtime of this.registry.values()) {
        if (!runtime.inject[name]?.required) continue
        const scopes = runtime.isReusable ? runtime.children : [runtime]
        for (const scope of scopes) {
          if (!this[symbols.filter](scope.ctx)) continue
          scope.start()
        }
      }
    }, { global: true }), Context.static, ctx.scope)

    // Check if service name is injected in any ancestor context
    const checkInject = (scope: EffectScope, name: string) => {
      if (!scope.runtime.plugin) return false
      for (const key in scope.runtime.inject) {
        if (name === ReflectService.resolveInject(scope.ctx, key)[0]) return true
      }
      return checkInject(scope.parent.scope, name)
    }

    defineProperty(this.on('internal/inject', function (this: Context, name) {
      return checkInject(this.scope, name)
    }, { global: true }), Context.static, ctx.scope)
  }

  /**
   * Await completion of all pending asynchronous lifecycle tasks.
   */
  async flush() {
    while (this._tasks.size) {
      await Promise.all(Array.from(this._tasks))
    }
  }

  /**
   * Filter hook list according to caller's context filter (e.g. service isolation).
   */
  filterHooks(hooks: Hook[], thisArg?: object) {
    thisArg = getTraceable(this.ctx, thisArg)
    return hooks.slice().filter((hook) => {
      const filter = thisArg?.[Context.filter]
      return hook.global || !filter || filter.call(thisArg, hook.ctx)
    })
  }

  /**
   * Generator that yields execution results of matching hooks for an event.
   */
  * dispatch(type: string, args: any[]) {
    const thisArg = typeof args[0] === 'object' || typeof args[0] === 'function' ? args.shift() : null
    const name = args.shift()
    if (name !== 'internal/event') {
      this.emit('internal/event', type, name, args, thisArg)
    }
    for (const hook of this.filterHooks(this._hooks[name] || [], thisArg)) {
      yield hook.callback.apply(thisArg, args)
    }
  }

  /**
   * Dispatch an event in parallel to all listeners and await completion.
   */
  async parallel(...args: any[]) {
    await Promise.all(this.dispatch('emit', args))
  }

  /**
   * Dispatch an event synchronously to all listeners.
   */
  emit(...args: any[]) {
    Array.from(this.dispatch('emit', args))
  }

  /**
   * Dispatch an event asynchronously in serial order until the first non-bailed result is encountered.
   */
  async serial(...args: any[]) {
    for await (const result of this.dispatch('serial', args)) {
      if (isBailed(result)) return result
    }
  }

  /**
   * Dispatch an event synchronously in serial order until the first non-bailed result is encountered.
   */
  bail(...args: any[]) {
    for (const result of this.dispatch('bail', args)) {
      if (isBailed(result)) return result
    }
  }

  /**
   * Register a hook callback and bind it to the context's scope for automatic disposal.
   */
  register(label: string, hooks: Hook[], callback: any, options: EventOptions) {
    const method = options.prepend ? 'unshift' : 'push'
    hooks[method]({ ctx: this.ctx, callback, ...options })
    return this.ctx.state.collect(label, () => this.unregister(hooks, callback))
  }

  /**
   * Remove a hook callback from the hooks array.
   */
  unregister(hooks: Hook[], callback: any) {
    const index = hooks.findIndex(hook => hook.callback === callback)
    if (index >= 0) {
      hooks.splice(index, 1)
      return true
    }
  }

  /**
   * Register an event listener on the current context.
   *
   * @param name Event name.
   * @param listener Callback function.
   * @param options Event options or boolean (shorthand for prepend).
   */
  on(name: string, listener: (...args: any) => any, options?: boolean | EventOptions) {
    if (typeof options !== 'object') {
      options = { prepend: options }
    }

    // handle special events
    this.ctx.scope.assertActive()
    listener = this.ctx.reflect.bind(listener)
    const result = this.bail(this.ctx, 'internal/listener', name, listener, options)
    if (result) return result

    const hooks = this._hooks[name] ||= []
    const label = typeof name === 'string' ? `event <${name}>` : 'event (Symbol)'
    return this.register(label, hooks, listener, options)
  }

  /**
   * Register a one-time event listener on the current context.
   */
  once(name: string, listener: (...args: any) => any, options?: boolean | EventOptions) {
    const dispose = this.on(name, function (...args: any[]) {
      dispose()
      return listener.apply(this, args)
    }, options)
    return dispose
  }

  /**
   * Start the lifecycle and trigger all registered `'ready'` hooks.
   */
  async start() {
    this.isActive = true
    const hooks = this._hooks.ready || []
    while (hooks.length) {
      const { ctx, callback } = hooks.shift()!
      ctx.scope.ensure(async () => callback())
    }
    await this.flush()
  }

  /**
   * Stop the lifecycle and reset all active context scopes.
   */
  async stop() {
    this.isActive = false
    // `dispose` event is handled by state.disposables
    this.ctx.scope.reset()
  }
}

export default Lifecycle

/**
 * Built-in event signature definitions in Cordis.
 *
 * @template C The Context subtype.
 */
export interface Events<in C extends Context = Context> {
  /** Fired when a plugin fork is created. */
  'fork'(ctx: C, config: C['config']): void
  /** Fired when the application lifecycle starts and is ready. */
  'ready'(): Awaitable<void>
  /** Fired when the scope or application context is disposed. */
  'dispose'(): Awaitable<void>
  /** Internal event fired on fork creation or disposal. */
  'internal/fork'(fork: ForkScope<C>): void
  /** Internal event fired on runtime creation or disposal. */
  'internal/runtime'(runtime: MainScope<C>): void
  /** Internal event fired when a scope status changes. */
  'internal/status'(scope: EffectScope<C>, oldValue: ScopeStatus): void
  /** Internal informational message. */
  'internal/info'(this: C, format: any, ...param: any[]): void
  /** Internal error message or exception. */
  'internal/error'(this: C, format: any, ...param: any[]): void
  /** Internal warning message. */
  'internal/warning'(this: C, format: any, ...param: any[]): void
  /** Internal event fired before a service value changes. */
  'internal/before-service'(this: C, name: string, value: any): void
  /** Internal event fired after a service value changes. */
  'internal/service'(this: C, name: string, value: any): void
  /** Internal event fired before a plugin configuration is updated. */
  'internal/before-update'(fork: ForkScope<C>, config: any): void
  /** Internal event fired after a plugin configuration is updated. */
  'internal/update'(fork: ForkScope<C>, oldConfig: any): void
  /** Internal hook to check if a service is injected in scope hierarchy. */
  'internal/inject'(this: C, name: string): boolean | undefined
  /** Internal hook allowing custom listener handling. */
  'internal/listener'(this: C, name: string, listener: any, prepend: boolean): void
  /** Internal telemetry event capturing all event dispatches. */
  'internal/event'(type: 'emit' | 'parallel' | 'serial' | 'bail', name: string, args: any[], thisArg: any): void
}

