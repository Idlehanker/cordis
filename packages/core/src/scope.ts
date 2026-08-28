import { deepEqual, defineProperty, Dict, isNullable, remove } from 'cosmokit'
import { Context } from './context.ts'
import { Inject, Plugin } from './registry.ts'
import { isConstructor, resolveConfig } from './utils.ts'

declare module './context.ts' {
  export interface Context {
    /** The active effect scope managing disposables and lifecycle for this context. */
    scope: EffectScope<this>
    /** The root `MainScope` runtime of the plugin associated with this context. */
    runtime: MainScope<this>

    /**
     * Register a disposable effect function in the current scope.
     *
     * The callback is executed immediately. If it returns a cleanup function or an object with a `dispose()` method,
     * the cleanup will be automatically invoked when this context scope is disposed or reset.
     *
     * @param callback The effect function or constructor to execute.
     * @returns The return value of the effect callback.
     */
    effect<T extends DisposableLike>(callback: Callable<T, [ctx: this]>): T
    effect<T extends DisposableLike, R>(callback: Callable<T, [ctx: this, config: R]>, config: R): T

    /**
     * Collect a named disposable cleanup callback into the current scope.
     *
     * @deprecated Use `ctx.effect()` instead.
     * @param label Name or label for the disposable.
     * @param callback Cleanup callback function.
     * @returns A function to manually trigger disposal.
     */
    collect(label: string, callback: () => void): () => void

    /**
     * Register a configuration update acceptor to handle dynamic config changes without restarting the scope.
     *
     * @param callback Optional handler receiving the new configuration. Return `true` to force a scope restart.
     * @param options Acceptor options (e.g. `immediate`, `passive`).
     * @returns A disposable function to unregister this acceptor.
     */
    accept(callback?: (config: this['config']) => void | boolean, options?: AcceptOptions): () => boolean

    /**
     * Register a configuration update acceptor for specific configuration keys.
     *
     * @param keys Configuration property keys to watch for changes.
     * @param callback Optional handler receiving the new configuration. Return `true` to force a scope restart.
     * @param options Acceptor options (e.g. `immediate`, `passive`).
     * @returns A disposable function to unregister this acceptor.
     */
    accept(keys: (keyof this['config'])[], callback?: (config: this['config']) => void | boolean, options?: AcceptOptions): () => boolean

    /**
     * Mark specific configuration keys as non-hot-reloadable, forcing a full scope restart when they change.
     *
     * @param keys Configuration property keys to watch.
     * @returns A disposable function to unregister this decline rule.
     */
    decline(keys: (keyof this['config'])[]): () => boolean
  }
}

/**
 * Cleanup function signature executed when a scope is disposed or reset.
 */
export type Disposable = () => void

/**
 * Represents a disposable resource, either a plain cleanup function or an object implementing `{ dispose: Disposable }`.
 */
export type DisposableLike = Disposable | { dispose: Disposable }

/**
 * Callable function or constructor type.
 */
export type Callable<T, R extends unknown[]> = ((...args: R) => T) | (new (...args: R) => T)

/**
 * Options for configuring dynamic config update acceptors.
 */
export interface AcceptOptions {
  /**
   * If `true`, the acceptor will not prevent restart when unwatched keys change.
   */
  passive?: boolean
  /**
   * If `true`, immediately invoke the callback upon registration with current config.
   */
  immediate?: boolean
}

/**
 * Internal acceptor descriptor stored in an EffectScope.
 */
export interface Acceptor extends AcceptOptions {
  /** Property keys to monitor. */
  keys?: string[]
  /** Callback to invoke on configuration update. Returning `true` signals that scope restart is required. */
  callback?: (config: any) => void | boolean
}

/**
 * Lifecycle status of an EffectScope.
 */
export const enum ScopeStatus {
  /** Scope is waiting for required dependencies to become available. */
  PENDING,
  /** Scope is executing asynchronous initialization tasks. */
  LOADING,
  /** Scope is fully initialized, dependencies satisfied, and active. */
  ACTIVE,
  /** Scope encountered an error during initialization or execution. */
  FAILED,
  /** Scope has been disposed and its resources cleaned up. */
  DISPOSED,
}

/**
 * Custom error class for Cordis runtime errors.
 */
export class CordisError extends Error {
  constructor(public code: CordisError.Code, message?: string) {
    super(message ?? CordisError.Code[code])
  }
}

/**
 * CordisError error code definitions and type declarations.
 */
export namespace CordisError {
  export type Code = keyof typeof Code

  export const Code = {
    INACTIVE_EFFECT: 'cannot create effect on inactive context',
  } as const
}

/**
 * Abstract base class managing disposables, lifecycle states, asynchronous tasks,
 * and reactive configuration updates for a context execution scope.
 *
 * @template C The Context subtype used in this scope.
 */
export abstract class EffectScope<C extends Context = Context> {
  /** Unique sequential identifier for this scope. Set to `null` once disposed. */
  public uid: number | null
  /** The context instance bound to this scope. */
  public ctx: C
  /** List of cleanup functions registered in this scope. */
  public disposables: Disposable[] = []
  /** Error object if the scope entered the `FAILED` state. */
  public error: any
  /** Current lifecycle status of this scope. */
  public status = ScopeStatus.PENDING
  /** Whether the scope is currently active and executing. */
  public isActive = false

  /** Protected reference to context. */
  protected context: Context
  /** Reactive proxy for configuration access when `isReactive` is enabled. */
  protected proxy: any
  /** Registered configuration update acceptors. */
  protected acceptors: Acceptor[] = []
  /** Set of pending asynchronous tasks belonging to this scope. */
  protected tasks = new Set<Promise<void>>()
  /** Internal flag indicating error state. */
  protected hasError = false

  /** Reference to the root `MainScope` runtime. */
  abstract runtime: MainScope<C>
  /** Dispose of this scope and all registered resources. */
  abstract dispose(): boolean
  /** Update the configuration of this scope. */
  abstract update(config: C['config'], forced?: boolean): void

  /**
   * Create a new EffectScope.
   *
   * @param parent The parent Context instance.
   * @param config Configuration object for this scope.
   */
  constructor(public parent: C, public config: C['config']) {
    this.uid = parent.registry ? parent.registry.counter : 0
    this.ctx = this.context = parent.extend({ scope: this })
    this.proxy = new Proxy({}, {
      get: (target, key) => Reflect.get(this.config, key),
    })
  }

  /**
   * Get the effective configuration object (reactive proxy if reactive, raw config otherwise).
   */
  protected get _config() {
    return this.runtime.isReactive ? this.proxy : this.config
  }

  /**
   * Assert that the current scope is active and has not been disposed.
   *
   * @throws {CordisError} If the scope is inactive/disposed.
   */
  assertActive() {
    if (this.uid !== null || this.isActive) return
    throw new CordisError('INACTIVE_EFFECT')
  }

  /**
   * Execute an effect function or constructor and register its return value for automatic disposal.
   *
   * @param callback The function or constructor to execute.
   * @param config Optional configuration passed to the callback.
   * @returns The disposable callback or result object.
   */
  effect(callback: Callable<DisposableLike, [ctx: C, config: any]>, config?: any) {
    this.assertActive()
    const result = isConstructor(callback)
      // eslint-disable-next-line new-cap
      ? new callback(this.ctx, config)
      : callback(this.ctx, config)
    let disposed = false
    const original = typeof result === 'function' ? result : result.dispose.bind(result)
    const wrapped = (...args: []) => {
      // make sure the original callback is not called twice
      if (disposed) return
      disposed = true
      remove(this.disposables, wrapped)
      return original(...args)
    }
    this.disposables.push(wrapped)
    if (typeof result === 'function') return wrapped
    result.dispose = wrapped
    return result
  }

  /**
   * Register a named disposable cleanup function in this scope.
   *
   * @param label Name or label for the disposable.
   * @param callback Function to run on cleanup.
   * @returns The wrapped disposable function.
   */
  collect(label: string, callback: () => any) {
    const dispose = defineProperty(() => {
      remove(this.disposables, dispose)
      return callback()
    }, 'name', label)
    this.disposables.push(dispose)
    return dispose
  }

  /**
   * Restart this scope by resetting all disposables, clearing errors, and calling `start()`.
   */
  restart() {
    this.reset()
    this.error = null
    this.hasError = false
    this.status = ScopeStatus.PENDING
    this.start()
  }

  /**
   * Compute the current lifecycle status based on uid, errors, pending tasks, and dependency readiness.
   */
  protected _getStatus() {
    if (this.uid === null) return ScopeStatus.DISPOSED
    if (this.hasError) return ScopeStatus.FAILED
    if (this.tasks.size) return ScopeStatus.LOADING
    if (this.ready) return ScopeStatus.ACTIVE
    return ScopeStatus.PENDING
  }

  /**
   * Update the status of this scope, emitting an `internal/status` event if the status changed.
   *
   * @param callback Optional mutation callback to execute before recalculating status.
   */
  updateStatus(callback?: () => void) {
    const oldValue = this.status
    callback?.()
    this.status = this._getStatus()
    if (oldValue !== this.status) {
      this.context.emit('internal/status', this, oldValue)
    }
  }

  /**
   * Register an asynchronous task and track it in `this.tasks` until completion.
   *
   * @param callback Async function returning a promise.
   */
  ensure(callback: () => Promise<void>) {
    const task = callback()
      .catch((reason) => {
        this.context.emit(this.ctx, 'internal/error', reason)
        this.cancel(reason)
      })
      .finally(() => {
        this.updateStatus(() => this.tasks.delete(task))
        this.context.events._tasks.delete(task)
      })
    this.updateStatus(() => this.tasks.add(task))
    this.context.events._tasks.add(task)
  }

  /**
   * Mark this scope as failed with an error reason and reset active disposables.
   *
   * @param reason The error that caused cancellation.
   */
  cancel(reason?: any) {
    this.error = reason
    this.updateStatus(() => this.hasError = true)
    this.reset()
  }

  /**
   * Check whether all required service dependencies are satisfied on the context.
   */
  get ready() {
    return Object.entries(this.runtime.inject).every(([name, inject]) => {
      return !inject.required || !isNullable(this.ctx.get(name))
    })
  }

  /**
   * Reset active state and execute all disposables (except static disposables bound to this scope).
   */
  reset() {
    this.isActive = false
    this.disposables = this.disposables.splice(0).filter((dispose) => {
      if (this.uid !== null && dispose[Context.static] === this) return true
        ; (async () => dispose())().catch((reason) => {
          this.context.emit(this.ctx, 'internal/error', reason)
        })
    })
  }

  /**
   * Initialize the scope with configuration or cancel if config is invalid.
   */
  protected init(error?: any) {
    if (!this.config) {
      this.cancel(error)
    } else {
      this.start()
    }
  }

  /**
   * Start the scope if all dependencies are ready, it is not already active, and not disposed.
   *
   * @returns `true` if activation was skipped (e.g. not ready or already active).
   */
  start() {
    if (!this.ready || this.isActive || this.uid === null) return true
    this.isActive = true
    this.updateStatus(() => this.hasError = false)
  }

  /**
   * Register a configuration update acceptor handler.
   */
  accept(callback?: (config: C['config']) => void | boolean, options?: AcceptOptions): () => boolean
  accept(keys: string[], callback?: (config: C['config']) => void | boolean, options?: AcceptOptions): () => boolean
  accept(...args: any[]) {
    const keys = Array.isArray(args[0]) ? args.shift() : null
    const acceptor: Acceptor = { keys, callback: args[0], ...args[1] }
    return this.effect(() => {
      this.acceptors.push(acceptor)
      if (acceptor.immediate) acceptor.callback?.(this.config)
      return () => remove(this.acceptors, acceptor)
    })
  }

  /**
   * Decline configuration updates for specified keys, forcing a scope restart when changed.
   */
  decline(keys: string[]) {
    return this.accept(keys, () => true)
  }

  /**
   * Compare resolved configuration against current configuration and determine whether
   * an update occurred and whether a restart is necessary based on registered acceptors.
   *
   * @param resolved The new validated configuration.
   * @param forced Whether update or restart is explicitly forced.
   * @returns Tuple of `[hasUpdate: boolean, shouldRestart: boolean]`.
   */
  checkUpdate(resolved: any, forced?: boolean) {
    if (forced || !this.config) return [true, true]
    if (forced === false) return [false, false]

    const modified: Record<string, boolean> = Object.create(null)
    const checkPropertyUpdate = (key: string) => {
      const result = modified[key] ??= !deepEqual(this.config[key], resolved[key])
      hasUpdate ||= result
      return result
    }

    const ignored = new Set<string>()
    let hasUpdate = false, shouldRestart = false
    let fallback: boolean | null = this.runtime.isReactive || null
    for (const { keys, callback, passive } of this.acceptors) {
      if (!keys) {
        fallback ||= !passive
      } else if (passive) {
        keys?.forEach(key => ignored.add(key))
      } else {
        let hasUpdate = false
        for (const key of keys) {
          hasUpdate ||= checkPropertyUpdate(key)
        }
        if (!hasUpdate) continue
      }
      const result = callback?.(resolved)
      if (result) shouldRestart = true
    }

    for (const key in { ...this.config, ...resolved }) {
      if (fallback === false) continue
      if (!(key in modified) && !ignored.has(key)) {
        const hasUpdate = checkPropertyUpdate(key)
        if (fallback === null) shouldRestart ||= hasUpdate
      }
    }
    return [hasUpdate, shouldRestart]
  }
}

/**
 * ForkScope represents a specific context fork / execution instance of a plugin.
 *
 * Each call to `ctx.plugin()` produces a `ForkScope` attached to the caller context,
 * allowing independent lifecycles, configuration overrides, and automatic cascade disposal.
 *
 * @template C The Context subtype.
 */
export class ForkScope<C extends Context = Context> extends EffectScope<C> {
  /** Function to dispose of this specific fork. */
  dispose: () => boolean

  /**
   * Create a new ForkScope.
   *
   * @param parent The calling context.
   * @param runtime The master MainScope runtime for the plugin.
   * @param config The fork configuration.
   * @param error Optional pre-existing error.
   */
  constructor(parent: Context, public runtime: MainScope<C>, config: C['config'], error?: any) {
    super(parent as C, config)

    this.dispose = defineProperty(parent.scope.collect(`fork <${parent.runtime.name}>`, () => {
      this.uid = null
      this.reset()
      this.context.emit('internal/fork', this)
      const result = remove(runtime.disposables, this.dispose)
      if (remove(runtime.children, this) && !runtime.children.length) {
        parent.registry.delete(runtime.plugin)
      }
      return result
    }), Context.static, runtime)

    runtime.children.push(this)
    runtime.disposables.push(this.dispose)
    this.context.emit('internal/fork', this)
    this.init(error)
  }

  /**
   * Activate this fork and execute all forkable callbacks registered by the master runtime.
   */
  start() {
    if (super.start()) return true
    for (const fork of this.runtime.forkables) {
      this.ensure(async () => fork(this.context, this._config))
    }
  }

  /**
   * Update the configuration of this fork.
   *
   * @param config New configuration object.
   * @param forced Whether to force update/restart.
   */
  update(config: any, forced?: boolean) {
    const oldConfig = this.config
    const state: EffectScope<C> = this.runtime.isForkable ? this : this.runtime
    if (state.config !== oldConfig) return
    let resolved: any
    try {
      resolved = resolveConfig(this.runtime.plugin, config)
    } catch (error) {
      this.context.emit('internal/error', error)
      return this.cancel(error)
    }
    const [hasUpdate, shouldRestart] = state.checkUpdate(resolved, forced)
    this.context.emit('internal/before-update', this, config)
    this.config = resolved
    state.config = resolved
    if (hasUpdate) {
      this.context.emit('internal/update', this, oldConfig)
    }
    if (shouldRestart) state.restart()
  }
}

/**
 * MainScope represents the master runtime state of a registered plugin in the Cordis registry.
 *
 * It manages the plugin definition, schema validation, dependency requirements (`inject`),
 * reusable child forks (`children`), and plugin instantiation (`apply`).
 *
 * @template C The Context subtype.
 */
export class MainScope<C extends Context = Context> extends EffectScope<C> {
  /** The value returned by instantiating the plugin (e.g. service instance). */
  public value: any

  /** Self-reference as runtime. */
  runtime = this
  /** Configuration schema / transform function. */
  schema: any
  /** Plugin name. */
  name?: string
  /** Resolved dependency requirements dictionary. */
  inject: Dict<Inject.Meta> = Object.create(null)
  /** List of factory/fork callbacks invoked when a child fork starts. */
  forkables: Function[] = []
  /** List of active child ForkScopes created from this runtime. */
  children: ForkScope<C>[] = []
  /** Whether the plugin is marked reusable across contexts. */
  isReusable?: boolean = false
  /** Whether the plugin configuration is reactive. */
  isReactive?: boolean = false

  /**
   * Create a new MainScope runtime.
   *
   * @param ctx The context where the plugin is registered.
   * @param plugin The plugin definition (null for root context).
   * @param config Initial configuration.
   * @param error Optional error during plugin resolution.
   */
  constructor(ctx: C, public plugin: Plugin, config: any, error?: any) {
    super(ctx, config)
    if (!plugin) {
      this.name = 'root'
      this.isActive = true
    } else {
      this.setup()
      this.init(error)
    }
  }

  /**
   * Whether this runtime contains forkable callbacks to execute per fork.
   */
  get isForkable() {
    return this.forkables.length > 0
  }

  /**
   * Create a new `ForkScope` attached to the specified parent context.
   *
   * @param parent The parent context requesting the fork.
   * @param config Configuration for the fork.
   * @param error Optional error state.
   * @returns The created ForkScope.
   */
  fork(parent: Context, config: any, error?: any) {
    return new ForkScope(parent, this, config, error)
  }

  /**
   * Dispose of this master runtime, clearing all child forks and listeners.
   */
  dispose() {
    this.uid = null
    this.reset()
    this.context.emit('internal/runtime', this)
    return true
  }

  /**
   * Parse plugin metadata (name, schema, inject, reusable, reactive) and prepare forkable callbacks.
   */
  private setup() {
    const { name } = this.plugin
    if (name && name !== 'apply') this.name = name
    this.schema = this.plugin['Config'] || this.plugin['schema']
    this.inject = Inject.resolve(this.plugin['using'] || this.plugin['inject'])
    this.isReusable = this.plugin['reusable']
    this.isReactive = this.plugin['reactive']
    this.context.emit('internal/runtime', this)

    if (this.isReusable) {
      this.forkables.push(this.apply)
    }
  }

  /**
   * Instantiate / execute the plugin definition.
   */
  private apply = (context: C, config: any) => {
    if (typeof this.plugin !== 'function') {
      return this.plugin.apply(context, config)
    } else if (isConstructor(this.plugin)) {
      // eslint-disable-next-line new-cap
      const instance = new this.plugin(context, config)
      const name = instance[Context.expose]
      if (name) {
        context.set(name, instance)
      }
      if (instance['fork']) {
        this.forkables.push(instance['fork'].bind(instance))
      }
      return instance
    } else {
      return this.plugin(context, config)
    }
  }

  /**
   * Reset this master runtime and cascade reset to all child forks.
   */
  reset() {
    super.reset()
    for (const fork of this.children) {
      fork.reset()
    }
  }

  /**
   * Start this master runtime and cascade start to all child forks.
   */
  start() {
    if (super.start()) return true
    if (!this.isReusable && this.plugin) {
      this.ensure(async () => this.value = this.apply(this.ctx, this._config))
    }
    for (const fork of this.children) {
      fork.start()
    }
  }

  /**
   * Update the configuration of this master runtime and synchronize child forks.
   *
   * @param config New configuration object.
   * @param forced Whether to force update/restart.
   */
  update(config: C['config'], forced?: boolean) {
    if (this.isForkable) {
      const warning = new Error(`attempting to update forkable plugin "${this.plugin.name}", which may lead to unexpected behavior`)
      this.context.emit(this.ctx, 'internal/warning', warning)
    }
    const oldConfig = this.config
    let resolved: any
    try {
      resolved = resolveConfig(this.runtime.plugin || this.context.constructor, config)
    } catch (error) {
      this.context.emit('internal/error', error)
      return this.cancel(error)
    }
    const [hasUpdate, shouldRestart] = this.checkUpdate(resolved, forced)
    const state = this.children.find(fork => fork.config === oldConfig)
    this.config = resolved
    if (state) {
      this.context.emit('internal/before-update', state, config)
      state.config = resolved
      if (hasUpdate) {
        this.context.emit('internal/update', state, oldConfig)
      }
    }
    if (shouldRestart) this.restart()
  }
}

