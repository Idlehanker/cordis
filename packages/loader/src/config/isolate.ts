import { Context } from '@cordisjs/core'
import { Dict } from 'cosmokit'
import { Entry } from './entry.ts'

declare module './entry.ts' {
  interface EntryUpdateMeta {
    /** The newly computed isolation mapping for the entry. */
    newMap: Dict<symbol>
    /**
     * Service transition diff records:
     * `[serviceKey, oldSymbol, newSymbol, entryDelimiter, sourceDelimiter]`
     */
    diff: [string, symbol, symbol, symbol, symbol][]
  }

  interface EntryOptions {
    /** Interception configuration mapping service keys to target interceptor handlers. */
    intercept?: Dict | null
    /**
     * Service isolation configuration mapping service keys to isolation realms.
     * - `true`: Local isolation realm private to this entry (`#<id>`).
     * - `string`: Named global isolation realm shared across entries (`@<label>`).
     */
    isolate?: Dict<true | string> | null
  }

  interface Entry {
    /** Lazy-initialized local isolation realm for this entry. */
    realm: LocalRealm
  }
}

/**
 * In-place replaces all own properties of `target` with those of `source`
 * while preserving the original object reference and prototype chain.
 *
 * @param target The target object to modify.
 * @param source Optional source object providing new properties.
 */
function swap<T extends {}>(target: T, source?: T | null) {
  for (const key of Reflect.ownKeys(target)) {
    Reflect.deleteProperty(target, key)
  }
  for (const key of Reflect.ownKeys(source || {})) {
    Reflect.defineProperty(target, key, Reflect.getOwnPropertyDescriptor(source!, key)!)
  }
}

/**
 * Abstract base class representing an isolation realm.
 *
 * Maps service name strings to unique symbols so that different realms
 * have distinct storage keys in `Context.store`.
 */
export abstract class Realm {
  /** Internal mapping of service names to realm-specific symbols. */
  protected store: Dict<symbol> = Object.create(null)

  /** Suffix appended to created symbols for debugging and tracing. */
  abstract get suffix(): string

  /**
   * Retrieves or creates an isolated symbol for the given service key.
   *
   * @param key The service name.
   * @param create Whether to create and persist the symbol in the store if absent.
   * @returns The isolation symbol for the service.
   */
  access(key: string, create = false) {
    if (create) {
      return this.store[key] ??= Symbol(`${key}${this.suffix}`)
    } else {
      return this.store[key] ?? Symbol(`${key}${this.suffix}`)
    }
  }

  /**
   * Deletes a service key mapping from this realm.
   *
   * @param key The service name.
   */
  delete(key: string) {
    delete this.store[key]
  }

  /**
   * The number of isolated service keys registered in this realm.
   */
  get size() {
    return Object.keys(this.store).length
  }
}

/**
 * Local isolation realm unique to a specific {@link Entry}.
 *
 * Symbol suffix format: `#<entry-id>`
 */
export class LocalRealm extends Realm {
  /**
   * Creates a LocalRealm bound to an entry.
   *
   * @param entry The owner entry.
   */
  constructor(private entry: Entry) {
    super()
  }

  get suffix() {
    return '#' + this.entry.options.id
  }
}

/**
 * Global isolation realm shared across multiple entries by name label.
 *
 * Symbol suffix format: `@<label>`
 */
export class GlobalRealm extends Realm {
  /**
   * Creates a GlobalRealm with a given label.
   *
   * @param label The realm name.
   */
  constructor(public label: string) {
    super()
  }

  get suffix() {
    return '@' + this.label
  }
}

/** Plugin name identifier. */
export const name = 'isolate'

/**
 * Installs service isolation and multi-tenancy support for configuration entries.
 *
 * Coordinates:
 * - Creating and resolving local/global isolation realms.
 * - Prototype inheritance setup for `Context.isolate` and `Context.intercept`.
 * - Calculating service transition diffs when entry isolation rules change.
 * - Emitting targeted `internal/before-service` and `internal/service` events with context filters.
 * - Migrating existing service instances in `Context.store` across isolation realms.
 * - Garbage collecting unreferenced global realms.
 *
 * @param ctx The root context instance.
 */
export function apply(ctx: Context) {
  /** Registry of named global isolation realms. */
  const realms: Dict<GlobalRealm> = Object.create(null)

  /**
   * Resolves the isolation symbol for a service on a given entry.
   *
   * @param entry The target entry.
   * @param key The service name.
   * @param create Whether to create missing realms or symbols.
   */
  function access(entry: Entry, key: string, create: true): symbol
  function access(entry: Entry, key: string, create?: boolean): symbol | undefined
  function access(entry: Entry, key: string, create = false) {
    let realm: Realm | undefined
    const label = entry.options.isolate?.[key]
    if (!label) return
    if (label === true) {
      realm = entry.realm ??= new LocalRealm(entry)
    } else if (create) {
      realm = realms[label] ??= new GlobalRealm(label)
    } else {
      realm = realms[label]
    }
    return realm?.access(key, create)
  }

  // Initialize isolation and interception maps inheriting from the context's prototype
  ctx.on('loader/entry-init', (entry) => {
    entry.ctx[Context.intercept] = Object.create(entry.ctx[Context.intercept])
    entry.ctx[Context.isolate] = Object.create(entry.ctx[Context.isolate])
  })

  // Prepare isolation changes before patching entry configuration
  ctx.on('loader/before-patch', function (entry) {
    // Step 1: Generate new isolate map inheriting from parent context
    this.newMap = Object.create(entry.parent.ctx[Context.isolate])
    for (const key of Object.keys(entry.options.isolate ?? {})) {
      this.newMap[key] = access(entry, key, true)
    }

    // Step 2: Generate service diff across changed isolation symbols
    this.diff = []
    const oldMap = entry.ctx[Context.isolate]
    for (const key in { ...this.newMap, ...entry.loader.delims }) {
      if (this.newMap[key] === oldMap[key]) continue
      const delim = entry.loader.delims[key] ??= Symbol(`delim:${key}`)
      entry.ctx[delim] = Symbol(`${key}#${entry.id}`)
      for (const symbol of [oldMap[key], this.newMap[key]]) {
        const item = symbol && entry.ctx[Context.store][symbol]
        if (!item) continue
        if (!item.source) {
          entry.ctx.emit(entry.ctx, 'internal/warning', new Error(`expected service ${key} to be implemented`))
          continue
        }
        this.diff.push([key, oldMap[key], this.newMap[key], entry.ctx[delim], item.source[delim]])
        if (entry.ctx[delim] !== item.source[delim]) break
      }
    }

    // Step 3: Emit internal/before-service with context filter restricted to affected realms
    for (const [key, symbol1, symbol2, flag1, flag2] of this.diff) {
      const self = Object.create(entry.ctx)
      self[Context.filter] = (target: Context) => {
        if (![symbol1, symbol2].includes(target[Context.isolate][key])) return false
        return (flag1 === target[entry.loader.delims[key]]) !== (flag1 === flag2)
      }
      entry.ctx.emit(self, 'internal/before-service', key)
    }

    // Step 4: Re-link prototype chains to parent context and swap in new mappings
    Object.setPrototypeOf(entry.ctx[Context.isolate], entry.parent.ctx[Context.isolate])
    Object.setPrototypeOf(entry.ctx[Context.intercept], entry.parent.ctx[Context.intercept])
    swap(entry.ctx[Context.isolate], this.newMap)
    swap(entry.ctx[Context.intercept], entry.options.intercept)
  })

  // Finalize service migration after entry patch
  ctx.on('loader/after-patch', function (entry) {
    // Step 5: If the service provider itself changed realms, transfer the implementation in Context.store
    for (const [, symbol1, symbol2, flag1, flag2] of this.diff) {
      if (flag1 === flag2 && entry.ctx[Context.store][symbol1] && !entry.ctx[Context.store][symbol2]) {
        entry.ctx[Context.store][symbol2] = entry.ctx[Context.store][symbol1]
        delete entry.ctx[Context.store][symbol1]
      }
    }

    // Step 6: Emit internal/service to notify consumers in the newly associated realms
    for (const [key, symbol1, symbol2, flag1, flag2] of this.diff) {
      const self = Object.create(entry.ctx)
      self[Context.filter] = (target: Context) => {
        if (![symbol1, symbol2].includes(target[Context.isolate][key])) return false
        return (flag1 === target[entry.loader.delims[key]]) !== (flag1 === flag2)
      }
      entry.ctx.emit(self, 'internal/service', key)
    }

    // Step 7: Clean up delimiter symbols no longer present in isolation map
    for (const key in entry.loader.delims) {
      if (!Reflect.ownKeys(this.newMap).includes(key)) {
        delete entry.ctx[entry.loader.delims[key]]
      }
    }
  })

  // Clean up unused global realms when entries are updated or removed
  ctx.on('loader/partial-dispose', (entry, legacy, active) => {
    for (const [key, label] of Object.entries(legacy.isolate ?? {})) {
      if (label === true) continue
      if (active && entry.options.isolate?.[key] === label) continue
      const realm = realms[label]
      if (!realm) continue

      // Realm garbage collection: check if any remaining entry references this realm
      for (const entry of ctx.loader.entries()) {
        if (entry.options.isolate?.[key] === realm.label) return
      }
      realm.delete(key)
      if (!realm.size) {
        delete realms[realm.label]
      }
    }
  })
}
