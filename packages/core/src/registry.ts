import { defineProperty, Dict } from 'cosmokit'
import { Context } from './context.ts'
import { ForkScope, MainScope } from './scope.ts'
import { resolveConfig, symbols, withProps } from './utils.ts'

/**
 * Check if the given object is an object-style plugin (i.e. has an `apply` method).
 *
 * In Cordis, an object plugin is any object that implements an `apply(ctx, config)` method.
 *
 * @param object The candidate value to check.
 * @returns `true` if the value is a valid object-style plugin, `false` otherwise.
 */
function isApplicable(object: Plugin) {
  return object && typeof object === 'object' && typeof object.apply === 'function'
}

/**
 * Service dependency declaration specification for plugins or methods.
 *
 * Can be defined in multiple formats:
 * - A string array of required service names: `['database', 'http']`
 * - A dictionary mapping service names to metadata: `{ database: { required: true }, timer: { required: false } }`
 * - An object with `required` and/or `optional` arrays: `{ required: ['database'], optional: ['timer'] }`
 */
export type Inject = string[] | Dict<Inject.Meta>

/**
 * TC39 Stage 3 Decorator for declaring service dependencies on classes or class methods.
 *
 * When applied to a class:
 * - Assigns the dependencies to `Class.inject`. Cordis will ensure these services are available
 *   before initializing or activating the plugin.
 *
 * When applied to a class method:
 * - Adds an initializer that listens for context attachment via `symbols.tracker`.
 * - Automatically invokes the method with a scoped context proxy once the injected services are loaded.
 *
 * @example
 * ```ts
 * // On class (Service / Plugin)
 * @Inject(['database', 'http'])
 * class MyService extends Service { ... }
 *
 * // On class method
 * class MyService extends Service {
 *   @Inject(['database'])
 *   onDatabaseReady() {
 *     // executed when database service becomes available
 *   }
 * }
 * ```
 *
 * @param inject The service dependencies required by the decorated class or method.
 * @returns A class or method decorator function.
 * @throws {Error} If applied to targets other than classes or class methods.
 */
export function Inject(inject: Inject) {
  return function (value: any, ctx: ClassDecoratorContext<any> | ClassMethodDecoratorContext<any>) {
    if (ctx.kind === 'class') {
      // For class decorators: attach dependency declaration directly to the constructor
      value.inject = inject
    } else if (ctx.kind === 'method') {
      // For method decorators: register an initializer that waits for dependencies
      ctx.addInitializer(function () {
        const property = this[symbols.tracker]?.property
        if (!property) throw new Error('missing context tracker')
        ;(this[property] as Context).inject(inject, (ctx) => {
          // Bind `this` with a proxy overriding the context property with the scoped injected context
          value.call(withProps(this, { [property]: ctx }))
        })
      })
    } else {
      throw new Error('@Inject can only be used on class or class methods')
    }
  }
}

export namespace Inject {
  /**
   * Metadata describing individual service dependency injection requirements.
   */
  export interface Meta {
    /**
     * Whether the dependency is strictly required.
     * If `true`, the plugin/scope will only activate when this service is available.
     * If `false`, the dependency is optional and will not block activation.
     */
    required: boolean
  }

  /**
   * Normalizes various dependency injection formats (`string[]`, object with `required`/`optional`, or direct dict)
   * into a standardized dictionary mapping service names to `Inject.Meta` descriptors.
   *
   * @param inject The raw dependency injection specification.
   * @returns A normalized mapping of service names to their dependency metadata.
   */
  export function resolve(inject: Inject | null | undefined) {
    if (!inject) return {}
    if (Array.isArray(inject)) {
      return Object.fromEntries(inject.map(name => [name, { required: true }]))
    }
    const { required, optional, ...rest } = inject
    if (Array.isArray(required)) {
      Object.assign(rest, Object.fromEntries(required.map(name => [name, { required: true }])))
    }
    if (Array.isArray(optional)) {
      Object.assign(rest, Object.fromEntries(optional.map(name => [name, { required: false }])))
    }
    return rest
  }
}

/**
 * Union type representing all valid forms of a Cordis plugin.
 *
 * A plugin can be:
 * 1. A function: `(ctx: Context, config: T) => void`
 * 2. A constructor / class: `new (ctx: Context, config: T) => void`
 * 3. An object with an `apply` method: `{ apply(ctx: Context, config: T): void }`
 *
 * @template C The Context subtype used by the plugin.
 * @template T The configuration type accepted by the plugin.
 */
export type Plugin<C extends Context = Context, T = any> =
  | Plugin.Function<C, T>
  | Plugin.Constructor<C, T>
  | Plugin.Object<C, T>

export namespace Plugin {
  /**
   * Common metadata and configuration options supported by all plugin forms.
   *
   * @template T The configuration schema/type of the plugin.
   */
  export interface Base<T = any> {
    /**
     * Display or identification name of the plugin, used in logging, debugging, and inspection.
     */
    name?: string
    /**
     * Whether the plugin's configuration should be reactive.
     * When `true`, configuration updates dynamically propagate to `ctx.config` without restarting the plugin.
     */
    reactive?: boolean
    /**
     * Whether the plugin can be applied multiple times in the context tree without duplicate warnings.
     */
    reusable?: boolean
    /**
     * Schema validation and transformation function for the plugin's configuration.
     */
    Config?: (config: any) => T
    /**
     * Service dependencies required by the plugin before it can be activated.
     */
    inject?: Inject
    /**
     * Interception table mapping service names to isolation/interception flags.
     */
    intercept?: Dict<boolean>
  }

  /**
   * Helper interface describing a plugin that transforms raw input config of type `S` into validated config of type `T`.
   *
   * @template S The raw input configuration type before transformation.
   * @template T The validated output configuration type.
   */
  export interface Transform<S, T> {
    /**
     * Flag indicating the presence of a schema definition.
     */
    schema?: true
    /**
     * Schema validation and transformation function.
     */
    Config: (config: S) => T
  }

  /**
   * Functional plugin signature.
   *
   * A function that receives the scoped context and configuration.
   *
   * @template C The Context subtype.
   * @template T The configuration type.
   */
  export interface Function<C extends Context = Context, T = any> extends Base<T> {
    (ctx: C, config: T): void
  }

  /**
   * Constructor / Class plugin signature.
   *
   * A class constructor instantiated with the scoped context and configuration.
   *
   * @template C The Context subtype.
   * @template T The configuration type.
   */
  export interface Constructor<C extends Context = Context, T = any> extends Base<T> {
    new (ctx: C, config: T): void
  }

  /**
   * Object-style plugin signature.
   *
   * An object containing an `apply` method that receives the scoped context and configuration.
   *
   * @template C The Context subtype.
   * @template T The configuration type.
   */
  export interface Object<C extends Context = Context, T = any> extends Base<T> {
    apply: (ctx: C, config: T) => void
  }
}

/**
 * Utility type to conditionally require a configuration argument:
 * - If `undefined extends T` (configuration is optional), produces `[config?: T]`.
 * - Otherwise, produces `[config: T]`.
 */
export type Spread<T> = undefined extends T ? [config?: T] : [config: T]

declare module './context.ts' {
  export interface Context {
    /**
     * Register a callback to execute when the specified dependencies become available.
     *
     * @deprecated Use `ctx.inject()` instead.
     * @param deps Service dependencies to inject.
     * @param callback Callback function executed with the injected context.
     * @returns A `ForkScope` representing this injection lifecycle.
     */
    using(deps: Inject, callback: Plugin.Function<this, void>): ForkScope<this>

    /**
     * Register a callback to execute when the specified dependencies become available.
     *
     * @param deps Service dependencies to inject.
     * @param callback Callback function executed with the injected context.
     * @returns A `ForkScope` representing this injection lifecycle.
     */
    inject(deps: Inject, callback: Plugin.Function<this, void>): ForkScope<this>

    /**
     * Load a functional plugin with configuration transformation schema.
     *
     * @param plugin The functional plugin to load.
     * @param args The configuration arguments.
     * @returns A `ForkScope` representing this plugin instance.
     */
    plugin<T = undefined, S = T>(plugin: Plugin.Function<this, T> & Plugin.Transform<S, T>, ...args: Spread<S>): ForkScope<this>

    /**
     * Load a constructor/class plugin with configuration transformation schema.
     *
     * @param plugin The constructor/class plugin to load.
     * @param args The configuration arguments.
     * @returns A `ForkScope` representing this plugin instance.
     */
    plugin<T = undefined, S = T>(plugin: Plugin.Constructor<this, T> & Plugin.Transform<S, T>, ...args: Spread<S>): ForkScope<this>

    /**
     * Load an object plugin with configuration transformation schema.
     *
     * @param plugin The object plugin to load.
     * @param args The configuration arguments.
     * @returns A `ForkScope` representing this plugin instance.
     */
    plugin<T = undefined, S = T>(plugin: Plugin.Object<this, T> & Plugin.Transform<S, T>, ...args: Spread<S>): ForkScope<this>

    /**
     * Load a functional plugin.
     *
     * @param plugin The functional plugin to load.
     * @param args The configuration arguments.
     * @returns A `ForkScope` representing this plugin instance.
     */
    plugin<T = undefined>(plugin: Plugin.Function<this, T>, ...args: Spread<T>): ForkScope<this>

    /**
     * Load a constructor/class plugin.
     *
     * @param plugin The constructor/class plugin to load.
     * @param args The configuration arguments.
     * @returns A `ForkScope` representing this plugin instance.
     */
    plugin<T = undefined>(plugin: Plugin.Constructor<this, T>, ...args: Spread<T>): ForkScope<this>

    /**
     * Load an object plugin.
     *
     * @param plugin The object plugin to load.
     * @param args The configuration arguments.
     * @returns A `ForkScope` representing this plugin instance.
     */
    plugin<T = undefined>(plugin: Plugin.Object<this, T>, ...args: Spread<T>): ForkScope<this>
  }
}

/**
 * Registry manages the lifecycle, storage, and instantiation of plugins within a Cordis application.
 *
 * It maintains the mapping between plugin definitions and their corresponding `MainScope` instances,
 * handles duplicate detection, validates configurations against schemas, generates sequential UIDs,
 * and manages dependency injection scopes.
 *
 * @template C The Context subtype used in this registry.
 */
class Registry<C extends Context = Context> {
  /** Internal sequence counter used to generate unique identifiers (`uid`) for scopes. */
  private _counter = 0

  /** Map storing active `MainScope` runtimes, keyed by their canonical function reference. */
  private _internal = new Map<Function, MainScope<C>>()

  /** Reference to the root or bound Context instance. */
  protected context: Context

  /**
   * Create a new Registry instance.
   *
   * Initializes the registry, establishes context tracking metadata, and sets up the root `MainScope`
   * representing the root application context itself.
   *
   * @param ctx The context instance associated with this registry.
   * @param config Initial root configuration.
   */
  constructor(public ctx: C, config: any) {
    defineProperty(this, symbols.tracker, {
      associate: 'registry',
      property: 'ctx',
    })

    this.context = ctx
    // Initialize the root MainScope (with null as plugin identifier)
    const runtime = new MainScope(ctx, null!, config)
    ctx.scope = runtime
    runtime.ctx = ctx
    this.set(null!, runtime)
  }

  /**
   * Increment and return the next unique sequence ID for an effect/fork scope.
   */
  get counter() {
    return ++this._counter
  }

  /**
   * Return the total number of registered plugins in this registry.
   */
  get size() {
    return this._internal.size
  }

  /**
   * Resolve a plugin definition to its canonical function key used in the internal storage map:
   * - `null` -> `null` (special case for root context)
   * - `function` -> the function itself (functions, classes)
   * - `object` with `apply` method -> `object.apply`
   *
   * @param plugin The plugin to resolve.
   * @param assert Whether to throw an error if the plugin is not a valid plugin type.
   * @returns The canonical function key, or `undefined` if invalid and `assert` is `false`.
   * @throws {Error} If `assert` is true and the plugin is not a valid function or applicable object.
   */
  resolve(plugin: Plugin, assert = false): Function | undefined {
    // Allow `null` as a special case.
    if (plugin === null) return plugin
    if (typeof plugin === 'function') return plugin
    if (isApplicable(plugin)) return plugin.apply
    if (assert) throw new Error('invalid plugin, expect function or object with an "apply" method, received ' + typeof plugin)
  }

  /**
   * Get the `MainScope` runtime associated with a given plugin.
   *
   * @param plugin The plugin definition to look up.
   * @returns The associated `MainScope`, or `undefined` if not registered.
   */
  get(plugin: Plugin) {
    const key = this.resolve(plugin)
    return key && this._internal.get(key)
  }

  /**
   * Check whether a plugin is currently registered in this registry.
   *
   * @param plugin The plugin definition to check.
   * @returns `true` if the plugin is registered, `false` otherwise.
   */
  has(plugin: Plugin) {
    const key = this.resolve(plugin)
    return !!key && this._internal.has(key)
  }

  /**
   * Store a `MainScope` runtime for a plugin in the internal registry map.
   *
   * @param plugin The plugin definition to associate.
   * @param state The `MainScope` runtime instance.
   */
  set(plugin: Plugin, state: MainScope<C>) {
    const key = this.resolve(plugin)
    this._internal.set(key!, state)
  }

  /**
   * Unregister a plugin from the registry and dispose of its `MainScope` runtime and all its forks.
   *
   * @param plugin The plugin definition to remove.
   * @returns The disposed `MainScope` runtime, or `undefined` if not found.
   */
  delete(plugin: Plugin) {
    const key = this.resolve(plugin)
    const runtime = key && this._internal.get(key)
    if (!runtime) return
    this._internal.delete(key)
    runtime.dispose()
    return runtime
  }

  /**
   * Returns an iterable iterator over all registered plugin keys (functions/methods).
   */
  keys() {
    return this._internal.keys()
  }

  /**
   * Returns an iterable iterator over all registered `MainScope` runtimes.
   */
  values() {
    return this._internal.values()
  }

  /**
   * Returns an iterable iterator over all `[key, MainScope]` entries.
   */
  entries() {
    return this._internal.entries()
  }

  /**
   * Execute a provided callback function once for each registered plugin in the registry.
   *
   * @param callback Callback to execute for each entry.
   */
  forEach(callback: (value: MainScope<C>, key: Function, map: Map<Plugin, MainScope<C>>) => void) {
    return this._internal.forEach(callback)
  }

  /**
   * Register a callback to execute when the specified dependencies become available.
   *
   * @deprecated Use `registry.inject()` instead.
   * @param inject Service dependencies to inject.
   * @param callback Callback function executed with the injected context.
   * @returns A `ForkScope` representing this injection.
   */
  using(inject: Inject, callback: Plugin.Function<C, void>) {
    return this.inject(inject, callback)
  }

  /**
   * Create an anonymous plugin that executes the callback once the declared service dependencies are ready.
   *
   * @param inject Service dependencies required before executing the callback.
   * @param callback Callback function to execute when dependencies are satisfied.
   * @returns A `ForkScope` representing this injection.
   */
  inject(inject: Inject, callback: Plugin.Function<C, void>) {
    return this.plugin({ inject, apply: callback, name: callback.name })
  }

  /**
   * Load and apply a plugin into the current context.
   *
   * The plugin loading pipeline:
   * 1. Validates that `plugin` is a valid functional, constructor, or object plugin.
   * 2. Asserts that the caller's context scope is active.
   * 3. Validates and transforms the configuration through the plugin's `Config` / schema (if provided).
   *    If validation fails, an `internal/error` event is emitted on the context.
   * 4. Checks if the plugin is already loaded:
   *    - If already loaded and non-reusable (`!runtime.isForkable`), emits an `internal/warning` event.
   *    - Forks the existing `MainScope` into the current context.
   * 5. If not loaded:
   *    - Creates a new `MainScope` runtime.
   *    - Registers it in the registry.
   *    - Creates and returns a `ForkScope` attached to the current context.
   *
   * @param plugin The plugin to load (function, constructor, or object with `apply`).
   * @param config Optional configuration object passed to the plugin.
   * @param error Optional pre-existing error state (e.g. from parent loader).
   * @returns A `ForkScope` representing the plugin's execution instance in this context.
   */
  plugin(plugin: Plugin<C>, config?: any, error?: any) {
    // check if it's a valid plugin
    this.resolve(plugin, true)
    this.ctx.scope.assertActive()

    // resolve plugin config
    if (!error) {
      try {
        config = resolveConfig(plugin, config)
      } catch (reason) {
        this.context.emit(this.ctx, 'internal/error', reason)
        error = reason
        config = null
      }
    }

    // check duplication
    let runtime = this.get(plugin)
    if (runtime) {
      if (!runtime.isForkable) {
        this.context.emit(this.ctx, 'internal/warning', new Error(`duplicate plugin detected: ${plugin.name}`))
      }
      return runtime.fork(this.ctx, config, error)
    }

    runtime = new MainScope(this.ctx, plugin, config, error)
    this.set(plugin, runtime)
    return runtime.fork(this.ctx, config, error)
  }
}

export default Registry
