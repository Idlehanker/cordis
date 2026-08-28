import { defineProperty, Dict, isNullable } from 'cosmokit'
import { Context } from './context.ts'
import { getTraceable, isObject, isUnproxyable, symbols, withProps } from './utils.ts'

declare module './context.ts' {
  export interface Context {
    /**
     * Retrieve a service instance by name, bound and traced to the current context.
     *
     * @param name The registered service name.
     * @returns The service instance or `undefined` if not registered or available.
     */
    get<K extends string & keyof this>(name: K): undefined | this[K]
    get(name: string): any

    /**
     * Register or update a service value on the context.
     *
     * When a service is set, an effect is created to automatically unregister it when this context scope is disposed.
     * Emits `internal/before-service` and `internal/service` lifecycle events.
     *
     * @param name The service name.
     * @param value The service value or instance.
     * @returns A disposable function to unregister the service.
     */
    set<K extends string & keyof this>(name: K, value: undefined | this[K]): () => void
    set(name: string, value: any): () => void

    /**
     * Define a service property descriptor on Context.
     *
     * @deprecated Use `ctx.set()` instead.
     * @param name The service name.
     * @param value Initial service value.
     * @param builtin Whether the service is a built-in core service.
     */
    provide(name: string, value?: any, builtin?: boolean): void

    /**
     * Register a dynamic accessor property (getter/setter) on Context.
     * The accessor will be automatically unregistered when this context's scope is disposed.
     *
     * @param name The property name.
     * @param options Getter and optional setter functions.
     */
    accessor(name: string, options: Omit<Context.Internal.Accessor, 'type'>): void

    /**
     * Register aliases pointing to an existing service or accessor on Context.
     *
     * @param name The canonical target service name.
     * @param aliases Array of alias names.
     */
    alias(name: string, aliases: string[]): void

    /**
     * Delegate properties and methods from a service or target object directly onto the Context.
     *
     * @param name Service name or target object.
     * @param mixins List of property keys or key-to-name mapping dictionary.
     */
    mixin<K extends string & keyof this>(name: K, mixins: (keyof this & keyof this[K])[] | Dict<string>): void
    mixin<T extends {}>(source: T, mixins: (keyof this & keyof T)[] | Dict<string>): void
  }
}

/**
 * ReflectService manages the dynamic Context Proxy behavior, service isolation resolution,
 * property accessors, mixins, and dependency usage warnings in Cordis.
 */
class ReflectService {
  /**
   * Resolve an alias chain to find the canonical service name and its internal descriptor.
   *
   * @param ctx The context to inspect.
   * @param name The initial property/alias name.
   * @returns Tuple containing `[canonicalName, internalDescriptor]`.
   */
  static resolveInject(ctx: Context, name: string) {
    let internal = ctx[symbols.internal][name]
    while (internal?.type === 'alias') {
      name = internal.name
      internal = ctx[symbols.internal][name]
    }
    return [name, internal] as const
  }

  /**
   * Verify that property access on Context is permitted according to declared plugin dependencies (`inject`),
   * emitting a warning event if undeclared services are accessed.
   *
   * @param ctx The calling context.
   * @param name Property/service name being accessed.
   * @param error Warning error object.
   */
  static checkInject(ctx: Context, name: string, error: Error) {
    ctx = ctx[symbols.shadow] ?? ctx
    // Case 1: built-in services and special properties
    // - prototype: prototype detection
    // - then: async function return
    if (['prototype', 'then', 'registry', 'lifecycle'].includes(name)) return
    // Case 2: `$` or `_` prefix
    if (name[0] === '$' || name[0] === '_') return
    // Case 3: access directly from root
    if (!ctx.runtime.plugin) return
    // Case 4: custom inject checks
    if (ctx.bail(ctx, 'internal/inject', name)) return
    ctx.emit(ctx, 'internal/warning', error)
  }

  /**
   * ProxyHandler applied to Context instances to intercept property access, service lookup, and method delegation.
   */
  static handler: ProxyHandler<Context> = {
    get: (target, prop, ctx: Context) => {
      if (typeof prop !== 'string') return Reflect.get(target, prop, ctx)

      if (Reflect.has(target, prop)) {
        return getTraceable(ctx, Reflect.get(target, prop, ctx), true)
      }

      const [name, internal] = ReflectService.resolveInject(target, prop)
      // trace caller
      const error = new Error(`property ${name} is not registered, declare it as \`inject\` to suppress this warning`)
      const lines = error.stack!.split('\n')
      lines.splice(1, 1)
      error.stack = lines.join('\n')
      if (!internal) {
        ReflectService.checkInject(ctx, name, error)
        return Reflect.get(target, name, ctx)
      } else if (internal.type === 'accessor') {
        return internal.get.call(ctx, ctx[symbols.receiver])
      } else {
        if (!internal.builtin) ReflectService.checkInject(ctx, name, error)
        return ctx.reflect.get(name)
      }
    },

    set: (target, prop, value, ctx: Context) => {
      if (typeof prop !== 'string') return Reflect.set(target, prop, value, ctx)

      const [name, internal] = ReflectService.resolveInject(target, prop)
      if (!internal) {
        // TODO warning
        return Reflect.set(target, name, value, ctx)
      }
      if (internal.type === 'accessor') {
        if (!internal.set) return false
        return internal.set.call(ctx, value, ctx[symbols.receiver])
      } else {
        // ctx.emit(ctx, 'internal/warning', new Error(`assigning to service ${name} is not recommended, please use \`ctx.set()\` method instead`))
        ctx.reflect.set(name, value)
        return true
      }
    },

    has: (target, prop) => {
      if (typeof prop !== 'string') return Reflect.has(target, prop)
      if (Reflect.has(target, prop)) return true
      const [, internal] = ReflectService.resolveInject(target, prop)
      return !!internal
    },
  }

  /**
   * Create a new ReflectService instance.
   *
   * Initializes context tracking metadata and mixes in core methods and properties from
   * `reflect`, `scope`, `registry`, and `lifecycle` onto the Context.
   *
   * @param ctx The context bound to this reflect service.
   */
  constructor(public ctx: Context) {
    defineProperty(this, symbols.tracker, {
      associate: 'reflect',
      property: 'ctx',
    })

    this._mixin('reflect', ['get', 'set', 'provide', 'accessor', 'mixin', 'alias'])
    this._mixin('scope', ['config', 'runtime', 'effect', 'collect', 'accept', 'decline'])
    this._mixin('registry', ['using', 'inject', 'plugin'])
    this._mixin('lifecycle', ['on', 'once', 'parallel', 'emit', 'serial', 'bail', 'start', 'stop'])
  }

  /**
   * Retrieve a service value from the store taking into account the context's service isolation key.
   *
   * @param name The service name.
   * @returns The traceable service instance or `undefined`.
   */
  get(name: string) {
    const internal = this.ctx[symbols.internal][name]
    if (internal?.type !== 'service') return
    const key = this.ctx[symbols.isolate][name]
    const value = this.ctx[symbols.store][key]?.value
    return getTraceable(this.ctx, value)
  }

  /**
   * Set or update a service value on the context with effect tracking and lifecycle event emission.
   *
   * @param name Service name.
   * @param value Service value.
   * @returns A disposable function to unregister the service.
   */
  set(name: string, value: any) {
    this.provide(name)
    const key = this.ctx[symbols.isolate][name]
    const oldValue = this.ctx[symbols.store][key]?.value
    value ??= undefined
    let dispose = () => {}
    if (oldValue === value) return dispose

    // check override
    if (!isNullable(value) && !isNullable(oldValue)) {
      throw new Error(`service ${name} has been registered`)
    }
    const ctx: Context = this.ctx
    if (!isNullable(value)) {
      dispose = ctx.effect(() => () => {
        ctx.set(name, undefined)
      })
    }
    if (isUnproxyable(value)) {
      ctx.emit(ctx, 'internal/warning', new Error(`service ${name} is an unproxyable object, which may lead to unexpected behavior`))
    }

    // setup filter for events
    const self = Object.create(ctx)
    self[symbols.filter] = (ctx2: Context) => {
      return ctx[symbols.isolate][name] === ctx2[symbols.isolate][name]
    }

    ctx.emit(self, 'internal/before-service', name, value)
    ctx[symbols.store][key] = { value, source: ctx }
    ctx.emit(self, 'internal/service', name, oldValue)
    return dispose
  }

  /**
   * Initialize a service entry in `symbols.internal` and setup its isolation key on the root context.
   *
   * @param name Service name.
   * @param value Optional initial value.
   * @param builtin Whether the service is a built-in core service.
   */
  provide(name: string, value?: any, builtin?: boolean) {
    const internal = this.ctx.root[symbols.internal]
    if (name in internal) return
    const key = Symbol(name)
    internal[name] = { type: 'service', builtin }
    this.ctx.root[symbols.isolate][name] = key
    if (!isObject(value)) return
    this.ctx[symbols.store][key] = { value, source: null! }
    defineProperty(value, symbols.tracker, {
      associate: name,
      property: 'ctx',
    })
  }

  /**
   * Internal implementation to register an accessor property on root Context.
   */
  _accessor(name: string, options: Omit<Context.Internal.Accessor, 'type'>) {
    const internal = this.ctx.root[symbols.internal]
    if (name in internal) return () => {}
    internal[name] = { type: 'accessor', ...options }
    return () => delete this.ctx.root[symbols.isolate][name]
  }

  /**
   * Register a dynamic accessor property (getter/setter) on Context bound to current scope.
   */
  accessor(name: string, options: Omit<Context.Internal.Accessor, 'type'>) {
    this.ctx.scope.effect(() => {
      return this._accessor(name, options)
    })
  }

  /**
   * Register aliases pointing to an existing service/accessor.
   */
  alias(name: string, aliases: string[]) {
    const internal = this.ctx.root[symbols.internal]
    if (name in internal) return
    for (const key of aliases) {
      internal[key] ||= { type: 'alias', name }
    }
  }

  /**
   * Internal implementation to mix in properties and methods onto Context.
   */
  _mixin(source: any, mixins: string[] | Dict<string>) {
    const entries = Array.isArray(mixins) ? mixins.map(key => [key, key]) : Object.entries(mixins)
    const getTarget = typeof source === 'string' ? (ctx: Context) => ctx[source] : () => source
    const disposables = entries.map(([key, value]) => {
      return this._accessor(value, {
        get(receiver) {
          const service = getTarget(this)
          if (isNullable(service)) return service
          const mixin = receiver ? withProps(receiver, service) : service
          const value = Reflect.get(service, key, mixin)
          if (typeof value !== 'function') return value
          return value.bind(mixin ?? service)
        },
        set(value, receiver) {
          const service = getTarget(this)
          const mixin = receiver ? withProps(receiver, service) : service
          return Reflect.set(service, key, value, mixin)
        },
      })
    })
    return () => disposables.forEach(dispose => dispose())
  }

  /**
   * Mix in properties and methods from a service or target object onto Context, bound to current scope.
   */
  mixin(source: any, mixins: string[] | Dict<string>) {
    this.ctx.scope.effect(() => {
      return this._mixin(source, mixins)
    })
  }

  /**
   * Wrap a value in a traceable proxy with current context.
   */
  trace<T>(value: T) {
    return getTraceable(this.ctx, value)
  }

  /**
   * Wrap a callback function to automatically trace `thisArg` and arguments upon execution.
   */
  bind<T extends Function>(callback: T) {
    return new Proxy(callback, {
      apply: (target, thisArg, args) => {
        return target.apply(this.trace(thisArg), args.map(arg => this.trace(arg)))
      },
    })
  }
}

export default ReflectService

