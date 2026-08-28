import { defineProperty, Dict } from 'cosmokit'
import Lifecycle from './events.ts'
import ReflectService from './reflect.ts'
import Registry from './registry.ts'
import { getTraceable, resolveConfig, symbols } from './utils.ts'

export { Lifecycle, ReflectService, Registry }

export namespace Context {
  /**
   * Utility type representing a Context parameterized with a specific configuration type `T`.
   */
  export type Parameterized<C, T = any> = C & { config: T }

  /**
   * Options for configuring property and method mixins on a Context.
   *
   * @deprecated Use `string[]` instead.
   */
  export interface MixinOptions {
    methods?: string[]
    accessors?: string[]
    prototype?: {}
  }

  /**
   * Stored value descriptor in the Context's service store.
   *
   * @template C The Context subtype that registered this service item.
   */
  export interface Item<C extends Context> {
    /** The actual service instance value. */
    value?: any
    /** The source context from which the service was registered. */
    source: C
  }

  /**
   * Unified internal descriptor type stored in the context's internal registration table (`symbols.internal`).
   */
  export type Internal = Internal.Service | Internal.Accessor | Internal.Alias

  export namespace Internal {
    /**
     * Descriptor for a registered service.
     */
    export interface Service {
      type: 'service'
      /** Whether the service is a core built-in service. */
      builtin?: boolean
      /** Prototype object of the service constructor. */
      prototype?: {}
    }

    /**
     * Descriptor for a dynamic accessor property (getter/setter) on Context.
     */
    export interface Accessor {
      type: 'accessor'
      /** Getter function invoked when reading the property on Context. */
      get: (this: Context, receiver: any) => any
      /** Optional setter function invoked when assigning to the property on Context. */
      set?: (this: Context, value: any, receiver: any) => boolean
    }

    /**
     * Descriptor for a property alias pointing to another registered service or accessor.
     */
    export interface Alias {
      type: 'alias'
      /** The target service/property name being aliased. */
      name: string
    }
  }
}

// https://github.com/typescript-eslint/typescript-eslint/issues/6720
// eslint-disable-next-line @typescript-eslint/no-unused-vars
/**
 * Interception configuration table mapping service names to intercept rules.
 * Intended to be augmented by plugins or extensions.
 */
export interface Intercept<C extends Context = Context> {}

/**
 * Context interface defining core properties, symbols, and service references.
 */
export interface Context {
  /** Internal store mapping isolation symbols to service values. */
  [Context.store]: Dict<Context.Item<this>, symbol>
  /** Mapping of service names to active isolation symbols on this context branch. */
  [Context.isolate]: Dict<symbol>
  /** Active interception configurations on this context branch. */
  [Context.intercept]: Intercept<this>
  /** Internal table storing service descriptors, accessors, and aliases. */
  [Context.internal]: Dict<Context.Internal>
  /** Reference to the root Context instance of the application. */
  root: this
  /** Event dispatcher and lifecycle manager for this context. */
  lifecycle: Lifecycle
  /** Reflection service managing dynamic accessors, mixins, and context proxy traps. */
  reflect: ReflectService
  /** Plugin registry managing loaded plugins, scopes, and dependency injection. */
  registry: Registry<this>
  /** Current configuration object associated with this context branch's scope. */
  config: any
}

/**
 * The central Inversion-of-Control (IoC) container, execution scope, and service bus in Cordis.
 *
 * Every plugin in Cordis receives a scoped `Context` instance. Contexts form a hierarchical tree
 * branching from the `root` context, supporting service injection, isolated service scopes,
 * event dispatching, and automatic lifecycle disposal.
 */
export class Context {
  /** Symbol accessing the internal service storage dictionary. */
  static readonly store: unique symbol = symbols.store as any
  /** Symbol accessing the lifecycle event emitter. */
  static readonly events: unique symbol = symbols.events as any
  /** Symbol used to mark static/permanent scope attachments. */
  static readonly static: unique symbol = symbols.static as any
  /** Symbol used for isolation filtering on event listeners and services. */
  static readonly filter: unique symbol = symbols.filter as any
  /** Symbol key indicating an immediate exposed service name. */
  static readonly expose: unique symbol = symbols.expose as any
  /** Symbol accessing the service isolation dictionary. */
  static readonly isolate: unique symbol = symbols.isolate as any
  /** Symbol accessing the internal service/accessor/alias table. */
  static readonly internal: unique symbol = symbols.internal as any
  /** Symbol accessing the interception configuration. */
  static readonly intercept: unique symbol = symbols.intercept as any
  /** Origin identifier for context tracking. */
  static readonly origin = 'ctx'
  /** Current identifier for context tracking. */
  static readonly current = 'ctx'

  /**
   * Type guard to check whether a given value is a Cordis `Context` instance.
   *
   * @template C The Context subtype.
   * @param value The value to inspect.
   * @returns `true` if `value` is a `Context`, `false` otherwise.
   */
  static is<C extends Context>(value: any): value is C {
    return !!value?.[Context.is as any]
  }

  static {
    Context.is[Symbol.toPrimitive] = () => Symbol.for('cordis.is')
    Context.prototype[Context.is as any] = true
  }

  /**
   * Associate an object with a named service tracker.
   *
   * @deprecated Use `Service.traceable` instead.
   * @param object Target object.
   * @param name Service name.
   */
  static associate<T extends {}>(object: T, name: string) {
    return object
  }

  /**
   * Create a new root Context instance.
   *
   * Initializes the internal service tables, creates the reflection handler proxy,
   * and sets up the root `ReflectService`, `Registry`, and `Lifecycle`.
   *
   * @param config Optional root configuration.
   */
  constructor(config?: any) {
    config = resolveConfig(this.constructor, config)
    this[symbols.store] = Object.create(null)
    this[symbols.isolate] = Object.create(null)
    this[symbols.internal] = Object.create(null)
    this[symbols.intercept] = Object.create(null)
    const self: Context = new Proxy(this, ReflectService.handler)
    self.root = self
    self.reflect = new ReflectService(self)
    self.registry = new Registry(self, config)
    self.lifecycle = new Lifecycle(self)

    // Recursively instantiate and attach built-in internal services defined on prototypes
    const attach = (internal: Context[typeof symbols.internal]) => {
      if (!internal) return
      attach(Object.getPrototypeOf(internal))
      for (const key of Object.getOwnPropertyNames(internal)) {
        const constructor = internal[key]['prototype']?.constructor
        if (!constructor) continue
        self[internal[key]['key']] = new constructor(self, config)
        defineProperty(self[internal[key]['key']], 'ctx', self)
      }
    }
    attach(this[symbols.internal])
    return self
  }

  /**
   * Custom inspect representation for Node.js `util.inspect`.
   *
   * Displays the context with its associated plugin/runtime name, e.g. `Context <root>` or `Context <my-plugin>`.
   */
  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `Context <${this.name}>`
  }

  /**
   * Get the nearest plugin/runtime name associated with this context branch.
   */
  get name() {
    let runtime = this.runtime
    while (runtime && !runtime.name) {
      runtime = runtime.parent.runtime
    }
    return runtime?.name!
  }

  /**
   * Alias to access the `Lifecycle` event manager on this context.
   */
  get events() {
    return this.lifecycle
  }

  /**
   * Alias to access the current `EffectScope` on this context.
   *
   * @deprecated Use `ctx.scope` instead.
   */
  get state() {
    return this.scope
  }

  /**
   * Create a new child Context branch derived from this context.
   *
   * The new context inherits prototype properties, service accessors, and isolation rules,
   * while allowing custom metadata or scope attachments to be applied.
   *
   * @param meta Optional metadata or properties to attach to the child context.
   * @returns A new child `Context` instance.
   */
  extend(meta = {}): this {
    const source = Reflect.getOwnPropertyDescriptor(this, symbols.shadow)?.value
    const self = Object.assign(Object.create(getTraceable(this, this)), meta)
    if (!source) return self
    return Object.assign(Object.create(self), { [symbols.shadow]: source })
  }

  /**
   * Create an isolated branch of this context for a specific service.
   *
   * In the returned context and its descendants, references to the specified service name
   * will resolve to a distinct, isolated instance identified by `label`.
   *
   * @param name The service name to isolate.
   * @param label Optional unique symbol identifying the isolation scope. Defaults to `Symbol(name)`.
   * @returns A new child `Context` with the service isolated.
   */
  isolate(name: string, label?: symbol) {
    const shadow = Object.create(this[symbols.isolate])
    shadow[name] = label ?? Symbol(name)
    return this.extend({ [symbols.isolate]: shadow })
  }

  /**
   * Configure interception options for a service on this context branch.
   *
   * @template K The service key in the Intercept table.
   * @param name The service name to intercept.
   * @param config The interception configuration values.
   * @returns A new child `Context` with the interception rules applied.
   */
  intercept<K extends keyof Intercept>(name: K, config: Intercept[K]) {
    const intercept = Object.create(this[symbols.intercept])
    intercept[name] = config
    return this.extend({ [symbols.intercept]: intercept })
  }
}

Context.prototype[Context.internal] = Object.create(null)

