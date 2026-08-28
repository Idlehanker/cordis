import { defineProperty } from 'cosmokit'
import type { Context, Service } from './index.ts'

/**
 * Metadata descriptor attached to traceable objects/services to track their origin and context binding.
 */
export interface Tracker {
  /**
   * The associated service name or component identifier in the internal context table.
   */
  associate?: string
  /**
   * The property name on the target object that holds the Context instance (e.g. `'ctx'`).
   */
  property?: string
}

/**
 * Well-known symbols used internally by Cordis for context isolation, reflection, and service lifecycle.
 */
export const symbols = {
  // internal symbols
  /** Symbol used to mark shadow prototype context bindings. */
  shadow: Symbol.for('cordis.shadow'),
  /** Symbol holding the active receiver object during accessor property evaluation. */
  receiver: Symbol.for('cordis.receiver'),
  /** Symbol accessing the unproxified original target object. */
  original: Symbol.for('cordis.original'),

  // context symbols
  /** Symbol key on Context storing the isolated service values dictionary. */
  store: Symbol.for('cordis.store') as typeof Context.store,
  /** Symbol key on Context referencing the Lifecycle event emitter. */
  events: Symbol.for('cordis.events') as typeof Context.events,
  /** Symbol key used to associate static scope disclaimers on disposables. */
  static: Symbol.for('cordis.static') as typeof Context.static,
  /** Symbol key on Service/Context for filtering event listeners based on isolation scopes. */
  filter: Symbol.for('cordis.filter') as typeof Context.filter,
  /** Symbol key indicating an immediate exposed service property name. */
  expose: Symbol.for('cordis.expose') as typeof Context.expose,
  /** Symbol key on Context storing the isolation symbol mapping for services. */
  isolate: Symbol.for('cordis.isolate') as typeof Context.isolate,
  /** Symbol key on Context storing internal registry table (services, accessors, aliases). */
  internal: Symbol.for('cordis.internal') as typeof Context.internal,
  /** Symbol key on Context storing context interception rules. */
  intercept: Symbol.for('cordis.intercept') as typeof Context.intercept,

  // service symbols
  /** Service lifecycle symbol for manual or standalone initialization setup. */
  setup: Symbol.for('cordis.setup') as typeof Service.setup,
  /** Service lifecycle symbol for callable services to handle function invocation. */
  invoke: Symbol.for('cordis.invoke') as typeof Service.invoke,
  /** Service lifecycle symbol for creating an extended/cloned service instance. */
  extend: Symbol.for('cordis.extend') as typeof Service.extend,
  /** Symbol property storing Tracker metadata on services and context-aware objects. */
  tracker: Symbol.for('cordis.tracker') as typeof Service.tracker,
  /** Symbol storing the default provided service name on a Service constructor. */
  provide: Symbol.for('cordis.provide') as typeof Service.provide,
  /** Symbol indicating whether a service should be exposed immediately upon construction. */
  immediate: Symbol.for('cordis.immediate') as typeof Service.immediate,
}

const GeneratorFunction = function* () {}.constructor
const AsyncGeneratorFunction = async function* () {}.constructor

/**
 * Determine whether a function is a standard class constructor or regular constructable function,
 * as opposed to an arrow function, async function, generator function, or async generator.
 *
 * @param func The function to test.
 * @returns `true` if constructable with `new`, `false` otherwise.
 */
export function isConstructor(func: any): func is new (...args: any) => any {
  // async function or arrow function do not have a prototype property
  if (!func.prototype) return false
  // generator function or malformed definition
  // we cannot use below check because `mock.fn()` is proxified
  // if (func.prototype.constructor !== func) return false
  if (func instanceof GeneratorFunction) return false
  // polyfilled AsyncGeneratorFunction === Function
  if (AsyncGeneratorFunction !== Function && func instanceof AsyncGeneratorFunction) return false
  return true
}

/**
 * Resolve and validate a plugin configuration using the plugin's schema or transformation function.
 *
 * Checks `plugin.Config` or `plugin.schema` to transform raw user config into validated config.
 *
 * @param plugin The plugin definition (function, class, or object).
 * @param config The raw configuration value passed by the user.
 * @returns The resolved configuration object (defaults to empty object `{}` if undefined/null).
 */
export function resolveConfig(plugin: any, config: any) {
  const schema = plugin['Config'] || plugin['schema']
  if (schema && plugin['schema'] !== false) config = schema(config)
  return config ?? {}
}

/**
 * Check if an object is an instance of a JavaScript standard built-in type
 * that cannot be safely proxied or shadowed (such as `Map`, `Set`, `Date`, `Promise`).
 *
 * @param value The value to inspect.
 * @returns `true` if unproxyable, `false` otherwise.
 */
export function isUnproxyable(value: any) {
  return [Map, Set, Date, Promise].some(constructor => value instanceof constructor)
}

/**
 * Recursively merge and link two prototype chains into a single merged prototype object.
 *
 * Copies own property descriptors from `proto1` onto a new prototype inheriting from `proto2`.
 *
 * @param proto1 Primary prototype whose own properties take precedence.
 * @param proto2 Base prototype to chain at the root of the hierarchy.
 * @returns A newly created linked prototype.
 */
export function joinPrototype(proto1: {}, proto2: {}) {
  if (proto1 === Object.prototype) return proto2
  const result = Object.create(joinPrototype(Object.getPrototypeOf(proto1), proto2))
  for (const key of Reflect.ownKeys(proto1)) {
    Object.defineProperty(result, key, Object.getOwnPropertyDescriptor(proto1, key)!)
  }
  return result
}

/**
 * Type guard to check if a value is a non-null object or function.
 *
 * @param value The value to inspect.
 * @returns `true` if `value` is an object or function.
 */
export function isObject(value: any): value is {} {
  return value && (typeof value === 'object' || typeof value === 'function')
}

/**
 * Wrap a target value in a traceable proxy that transparently tracks its context association,
 * shadows property lookups, and binds method invocations to the caller's context.
 *
 * @template T The type of the value being traced.
 * @param ctx The active Context instance to bind to the value.
 * @param value The object, function, or service instance to wrap.
 * @param noTrap If `true`, disables method proxy trapping.
 * @returns The traceable proxy, or the original value if not traceable.
 */
export function getTraceable<T>(ctx: Context, value: T, noTrap?: boolean): T {
  if (!isObject(value)) return value
  if (Object.hasOwn(value, symbols.shadow)) {
    return Object.getPrototypeOf(value)
  }
  const tracker = value[symbols.tracker]
  if (!tracker) return value
  return createTraceable(ctx, value, tracker, noTrap)
}

/**
 * Create a proxy over a target object that dynamically overlays additional properties from `props`.
 *
 * Property lookups and assignments are first checked against `props` (excluding `'constructor'`),
 * falling back to `target`.
 *
 * @param target The underlying target object.
 * @param props Optional properties to overlay.
 * @returns A proxy with overlaid properties, or `target` if `props` is falsy.
 */
export function withProps(target: any, props?: {}) {
  if (!props) return target
  return new Proxy(target, {
    get: (target, prop, receiver) => {
      if (prop in props && prop !== 'constructor') return Reflect.get(props, prop, receiver)
      return Reflect.get(target, prop, receiver)
    },
    set: (target, prop, value, receiver) => {
      if (prop in props && prop !== 'constructor') return Reflect.set(props, prop, value, receiver)
      return Reflect.set(target, prop, value, receiver)
    },
  })
}

/**
 * Overlay a single property onto `target` with non-writable access.
 *
 * @param target The target object.
 * @param prop The property key.
 * @param value The property value.
 */
function withProp(target: any, prop: string | symbol, value: any) {
  return withProps(target, Object.defineProperty(Object.create(null), prop, {
    value,
    writable: false,
  }))
}

/**
 * Create a shadow context receiver when accessing properties on a traceable service.
 * Preserves the original context in `symbols.shadow` for hierarchy lookups.
 */
function createShadow(ctx: Context, target: any, property: string | undefined, receiver: any) {
  if (!property) return receiver
  const origin = Reflect.getOwnPropertyDescriptor(target, property)?.value
  if (!origin) return receiver
  return withProp(receiver, property, ctx.extend({ [symbols.shadow]: origin }))
}

/**
 * Wrap a service method in a proxy ensuring contravariant `thisArg`/arguments and covariant return values
 * are properly traced and mapped with the caller's context.
 */
function createShadowMethod(ctx: Context, value: any, outer: any, shadow: {}) {
  return new Proxy(value, {
    apply: (target, thisArg, args) => {
      // contravariant: remap outer receiver to shadow receiver
      if (thisArg === outer) thisArg = shadow
      // contravariant: wrap function arguments with traceable proxies
      args = args.map((arg) => {
        if (typeof arg !== 'function' || arg[symbols.original]) return arg
        return new Proxy(arg, {
          get: (target, prop, receiver) => {
            if (prop === symbols.original) return target
            const value = Reflect.get(target, prop, receiver)
            // https://github.com/cordiverse/cordis/issues/14
            if (prop === 'toString' && value === Function.prototype.toString) {
              return function (...args: any[]) {
                return Reflect.apply(value, this === receiver ? target : this, args)
              }
            }
            return value
          },
          apply: (target: Function, thisArg, args) => {
            // covariant: trace arguments and thisArg upon callback invocation
            return Reflect.apply(target, getTraceable(ctx, thisArg), args.map(arg => getTraceable(ctx, arg)))
          },
          construct: (target: Function, args, newTarget) => {
            // covariant: trace constructor arguments
            return Reflect.construct(target, args.map(arg => getTraceable(ctx, arg)), newTarget)
          },
        })
      })
      // covariant: wrap return value in traceable proxy
      return getTraceable(ctx, Reflect.apply(target, thisArg, args))
    },
  })
}

/**
 * Construct a Proxy around a value using its Tracker metadata to intercept property access,
 * service delegation, and method binding to the current Context.
 */
function createTraceable(ctx: Context, value: any, tracker: Tracker, noTrap?: boolean) {
  if (ctx[symbols.shadow]) {
    ctx = Object.getPrototypeOf(ctx)
  }
  const proxy = new Proxy(value, {
    get: (target, prop, receiver) => {
      if (prop === symbols.original) return target
      if (prop === tracker.property) return ctx
      if (typeof prop === 'symbol') {
        return Reflect.get(target, prop, receiver)
      }
      if (tracker.associate && ctx[symbols.internal][`${tracker.associate}.${prop}`]) {
        return Reflect.get(ctx, `${tracker.associate}.${prop}`, withProp(ctx, symbols.receiver, receiver))
      }
      const shadow = createShadow(ctx, target, tracker.property, receiver)
      const innerValue = Reflect.get(target, prop, shadow)
      const innerTracker = innerValue?.[symbols.tracker]
      if (innerTracker) {
        return createTraceable(ctx, innerValue, innerTracker)
      } else if (!noTrap && typeof innerValue === 'function') {
        return createShadowMethod(ctx, innerValue, receiver, shadow)
      } else {
        return innerValue
      }
    },
    set: (target, prop, value, receiver) => {
      if (prop === symbols.original) return false
      if (prop === tracker.property) return false
      if (typeof prop === 'symbol') {
        return Reflect.set(target, prop, value, receiver)
      }
      if (tracker.associate && ctx[symbols.internal][`${tracker.associate}.${prop}`]) {
        return Reflect.set(ctx, `${tracker.associate}.${prop}`, value, withProp(ctx, symbols.receiver, receiver))
      }
      const shadow = createShadow(ctx, target, tracker.property, receiver)
      return Reflect.set(target, prop, value, shadow)
    },
    apply: (target, thisArg, args) => {
      return applyTraceable(proxy, target, thisArg, args)
    },
  })
  return proxy
}

/**
 * Invoke a traceable callable function/service, delegating to `symbols.invoke` if defined.
 */
function applyTraceable(proxy: any, value: any, thisArg: any, args: any[]) {
  if (!value[symbols.invoke]) return Reflect.apply(value, thisArg, args)
  return value[symbols.invoke].apply(proxy, args)
}

/**
 * Create a callable service function that inherits from a prototype and delegates function invocations
 * to `Service.invoke` while maintaining context traceability.
 *
 * @param name The name of the callable function/service.
 * @param proto The prototype object to inherit from.
 * @param tracker Context tracker metadata.
 * @returns A callable function object with the specified prototype and context tracing.
 */
export function createCallable(name: string, proto: {}, tracker: Tracker) {
  const self = function (...args: any[]) {
    const proxy = createTraceable(self['ctx'], self, tracker)
    return applyTraceable(proxy, self, this, args)
  }
  defineProperty(self, 'name', name)
  return Object.setPrototypeOf(self, proto)
}

