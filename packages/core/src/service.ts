import { Awaitable, defineProperty } from 'cosmokit'
import { Context } from './context.ts'
import { createCallable, joinPrototype, symbols, Tracker } from './utils.ts'
import { Spread } from './registry.ts'

/**
 * Base class for all context-aware injectable services in Cordis.
 *
 * Extending `Service` allows you to create services that:
 * - Automatically register themselves on the Context under `this.name` or `Service.provide`.
 * - Hook into the Cordis lifecycle via `start()` (on `ready`) and `stop()` (on `dispose`).
 * - Support callable service signatures via the `Service.invoke` symbol.
 * - Support service isolation across context branches.
 *
 * @template T The configuration type accepted by the service.
 * @template C The Context subtype used by the service.
 */
export abstract class Service<T = unknown, C extends Context = Context> {
  /** Symbol for custom / manual setup logic. */
  static readonly setup: unique symbol = symbols.setup as any
  /** Symbol for defining a callable function body when the service itself is invoked as a function. */
  static readonly invoke: unique symbol = symbols.invoke as any
  /** Symbol for creating an extended/cloned copy of the service. */
  static readonly extend: unique symbol = symbols.extend as any
  /** Symbol referencing the Tracker metadata descriptor. */
  static readonly tracker: unique symbol = symbols.tracker as any
  /** Static property symbol defining the default service name to provide on context. */
  static readonly provide: unique symbol = symbols.provide as any
  /** Static property symbol indicating whether the service should be exposed on context immediately upon construction. */
  static readonly immediate: unique symbol = symbols.immediate as any

  /**
   * Lifecycle hook executed when the application context is ready.
   *
   * Override this method to perform asynchronous initialization tasks (connecting to databases, starting servers, etc.).
   */
  protected start(): Awaitable<void> { }

  /**
   * Lifecycle hook executed when the service context is disposed.
   *
   * Override this method to perform cleanup tasks (closing connections, clearing timers, etc.).
   */
  protected stop(): Awaitable<void> { }

  /**
   * Optional fork hook invoked when a fork of this service is instantiated in a child context.
   *
   * @param ctx The child context.
   * @param config The fork configuration.
   */
  protected fork?(ctx: C, config: any): void

  /** The context instance bound to this service. */
  protected ctx!: C

  /** The registered service name (e.g. `'database'`, `'http'`). */
  public name!: string

  /** The configuration object passed to this service. */
  public config!: T

  /**
   * Instantiate a service in standalone mode without passing an existing Context.
   *
   * @param args Configuration argument(s).
   */
  constructor(...args: Spread<T>)

  /**
   * Instantiate a service bound to an existing Context.
   *
   * @param ctx The context to bind to.
   * @param args Configuration argument(s).
   */
  constructor(ctx: C, ...args: Spread<T>)

  /**
   * Instantiate a service with explicit name and immediate exposure flag.
   *
   * @param ctx The context to bind to.
   * @param name Explicit service name.
   * @param immediate Whether to expose the service immediately.
   */
  constructor(ctx: C, name: string, immediate?: boolean)

  constructor(...args: any[]) {
    let _ctx: C | undefined, name: string | undefined, immediate: boolean | undefined, config: any
    if (Context.is<C>(args[0])) {
      _ctx = args[0]
      if (typeof args[1] === 'string') {
        name = args[1]
        immediate = args[2]
      } else {
        config = args[1]
      }
    } else {
      config = args[0]
    }
    name ??= this.constructor[symbols.provide] as string
    immediate ??= this.constructor[symbols.immediate]

    let self = this
    const tracker: Tracker = {
      associate: name,
      property: 'ctx',
    }
    // If the service implements `Service.invoke`, convert it to a callable function proxy
    if (self[symbols.invoke]) {
      self = createCallable(
        name,
        joinPrototype(Object.getPrototypeOf(this), Function.prototype),
        tracker
      )
    }
    if (_ctx) {
      self.ctx = _ctx
    } else {
      self[symbols.setup]()
    }
    self.name = name
    self.config = config
    defineProperty(self, symbols.tracker, tracker)

    self.ctx.provide(name)
    self.ctx.runtime.name = name
    if (immediate) {
      if (_ctx) self[symbols.expose] = name
      else self.ctx.set(name, self)
    }

    // Register lifecycle listener: start the service on 'ready'
    self.ctx.on('ready', async () => {
      // await until next tick because derived class has not been initialized yet
      await Promise.resolve()
      await self.start()
      if (!immediate) self.ctx.set(name!, self)
    })

    // Register lifecycle listener: stop the service on 'dispose'
    self.ctx.on('dispose', () => self.stop())
    return self
  }

  /**
   * Filter hook to verify whether an event from `ctx` should be received by this service,
   * taking service isolation symbols into account.
   *
   * @param ctx The calling context to test against.
   * @returns `true` if the context belongs to the same isolation domain.
   */
  protected [symbols.filter](ctx: Context) {
    return ctx[symbols.isolate][this.name] === this.ctx[symbols.isolate][this.name]
  }

  /**
   * Default setup method creating an isolated fallback context when no context was passed to constructor.
   */
  protected [symbols.setup]() {
    this.ctx = new Context() as C
  }

  /**
   * Create an extended / cloned service instance inheriting from this service.
   *
   * @param props Optional properties to overlay on the clone.
   * @returns The extended service instance.
   */
  protected [symbols.extend](props?: any) {
    let self: any
    if (this[Service.invoke]) {
      self = createCallable(this.name, this, this[symbols.tracker])
    } else {
      self = Object.create(this)
    }
    return Object.assign(self, props)
  }

  /**
   * Custom `instanceof` check traversing through potential proxy wrappers and prototype chains.
   */
  static [Symbol.hasInstance](instance: any) {
    let constructor = instance.constructor
    while (constructor) {
      // constructor may be a proxy
      constructor = constructor.prototype?.constructor
      if (constructor === this) return true
      constructor = Object.getPrototypeOf(constructor)
    }
    return false
  }
}

