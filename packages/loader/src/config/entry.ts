import { Context, ForkScope } from '@cordisjs/core'
import { isNullable } from 'cosmokit'
import { Loader } from '../loader.ts'
import { EntryGroup } from './group.ts'
import { EntryTree } from './tree.ts'
import { evaluate, interpolate } from './utils.ts'

/**
 * Options defining a single configured plugin entry in the loader tree.
 */
export interface EntryOptions {
  /** Unique identifier for the entry within its enclosing tree. */
  id: string
  /** Module specifier, package name, or plugin identifier. */
  name: string
  /** Configuration payload passed to the plugin upon initialization. */
  config?: any
  /** Whether this entry serves as a group container for nested entries. */
  group?: boolean | null
  /** Whether this entry is explicitly disabled. */
  disabled?: boolean | null
}

/**
 * Metadata object shared across `loader/before-patch` and `loader/after-patch` event hooks.
 *
 * Can be augmented by extension modules (e.g. `isolate.ts`) to pass diff state.
 */
export interface EntryUpdateMeta { }

/**
 * Extracts and removes specified keys from an object in order.
 *
 * @param object The target object to extract keys from.
 * @param keys Array of property keys to take.
 * @returns Array of key-value tuples for the matched properties.
 */
function takeEntries(object: {}, keys: string[]) {
  const result: [string, any][] = []
  for (const key of keys) {
    if (!(key in object)) continue
    result.push([key, object[key]])
    delete object[key]
  }
  return result
}

/**
 * Reorders object keys in canonical order for predictable configuration serialization:
 * `prepend` keys first (e.g. `'id'`, `'name'`), alphabetical middle keys, and `append` keys last (e.g. `'config'`).
 *
 * @param object The object whose keys should be reordered.
 * @param prepend Keys that should appear first.
 * @param append Keys that should appear last.
 * @returns The mutated object with reordered properties.
 */
function sortKeys<T extends {}>(object: T, prepend = ['id', 'name'], append = ['config']): T {
  const part1 = takeEntries(object, prepend)
  const part2 = takeEntries(object, append)
  const rest = takeEntries(object, Object.keys(object)).sort(([a], [b]) => a.localeCompare(b))
  return Object.assign(object, Object.fromEntries([...part1, ...rest, ...part2]))
}

/**
 * Represents a single configured plugin node in the loader's execution tree.
 *
 * Manages the lifecycle of a plugin instance:
 * - Scoped child context (`ctx`) and active plugin fork (`fork`).
 * - Dynamic config interpolation and JS expression evaluation.
 * - Hierarchical disable resolution across ancestor groups.
 * - Patching context prototype chains and updating running forks.
 *
 * @template C The Context subtype.
 */
export class Entry<C extends Context = Context> {
  /** Symbol used to attach the Entry reference to a context for fork correlation. */
  static readonly key = Symbol.for('cordis.entry')

  /** Scoped child context dedicated to this entry. */
  public ctx: C

  /** The active plugin fork scope if the entry is running. */
  public fork?: ForkScope<C>

  /** Internal flag to suppress recursive write events during self-updates. */
  public suspend = false

  /** The parent group containing this entry. */
  public parent!: EntryGroup

  /** Current options and configuration for this entry. */
  public options!: EntryOptions

  /** Associated subgroup if this entry represents a plugin group. */
  public subgroup?: EntryGroup

  /** Associated subtree if this entry represents an imported config tree. */
  public subtree?: EntryTree<C>


  /**
   * Creates an Entry instance bound to a loader.
   *
   * @param loader The loader managing this entry.
   */
  constructor(public loader: Loader<C>) {
    this.ctx = loader.ctx.extend()
    this.context.emit('loader/entry-init', this)
  }

  /**
   * The context instance associated with this entry.
   */
  get context(): Context {
    return this.ctx
  }

  /**
   * Fully qualified hierarchical ID for this entry.
   *
   * If nested within an imported subtree, prefixes the ancestor entry ID with `EntryTree.sep` (e.g. `"parent:child"`).
   */
  get id() {
    let id = this.options.id
    if (this.parent.tree.ctx.scope.entry) {
      id = this.parent.tree.ctx.scope.entry.id + EntryTree.sep + id
    }
    return id
  }

  /**
   * Computes whether this entry is disabled, taking into account ancestor group disable states.
   *
   * Group entries are never considered disabled themselves, but their children inherit the disable state.
   */
  get disabled() {
    // Groups are structural containers and always report enabled at the container level
    if (this.options.group) return false
    let entry: Entry | undefined = this
    do {
      if (entry.options.disabled) return true
      entry = entry.parent.ctx.scope.entry
    } while (entry)
    return false
  }

  /**
   * Validates whether this entry meets all preconditions to start.
   *
   * Checks `this.disabled` and triggers `loader/entry-check` bail event listeners (e.g. required services).
   *
   * @returns `true` if the entry is eligible to be active, `false` otherwise.
   */
  _check() {
    if (this.disabled) return false
    return !this.parent.ctx.bail('loader/entry-check', this)
  }

  /**
   * Evaluates a JavaScript expression in the scope of this entry's context.
   *
   * @param expr The expression string.
   * @returns The evaluated result.
   */
  evaluate(expr: string) {
    return evaluate(this.ctx, expr)
  }

  /**
   * Resolves and interpolates configuration expressions against the entry's context.
   *
   * Skips interpolation for group plugins.
   *
   * @param plugin The resolved plugin definition.
   * @returns A tuple of `[resolvedConfig, error?]`.
   */
  _resolveConfig(plugin: any): [any, any?] {
    if (plugin[EntryGroup.key]) return [this.options.config]
    try {
      return [interpolate(this.ctx, this.options.config)]
    } catch (error) {
      this.context.emit(this.ctx, 'internal/error', error)
      return [null, error]
    }
  }

  /**
   * Applies runtime updates to the entry context and fork without full re-creation.
   *
   * Handles:
   * - Emitting `loader/before-patch` and `loader/after-patch`.
   * - Re-parenting context prototype to `parent.ctx`.
   * - Updating config in running fork.
   * - Propagating disable changes down to subgroup children.
   *
   * @param options Partial options that changed.
   */
  patch(options: Partial<EntryOptions> = {}) {
    // Step 1: Notify listeners to prepare isolation maps and compute diffs
    const meta = {} as EntryUpdateMeta
    this.context.emit(meta, 'loader/before-patch', this)

    // Step 2: Update context prototype chain to inherit from parent group's context
    Object.setPrototypeOf(this.ctx, this.parent.ctx)

    if (this.fork && 'config' in options) {
      // Step 3a: Update running fork configuration
      this.suspend = true
      const [config, error] = this._resolveConfig(this.fork.runtime.plugin)
      if (error) {
        this.fork.cancel(error)
      } else {
        this.fork.update(config)
      }
    } else if (this.subgroup && 'disabled' in options) {
      // Step 3b: Propagate disable state changes to child entries in subgroup
      const tree = this.subtree ?? this.parent.tree
      for (const options of this.subgroup.data) {
        tree.store[options.id].update({
          disabled: options.disabled,
        })
      }
    }

    // Step 4: Notify listeners that patch is complete (e.g. migrate service implementations)
    this.context.emit(meta, 'loader/after-patch', this)
  }

  /**
   * Re-evaluates entry readiness and toggles running state accordingly.
   *
   * Starts the plugin if ready and inactive; stops the plugin if no longer ready.
   */
  async refresh() {
    const ready = this._check()
    if (ready && !this.fork) {
      await this.start()
    } else if (!ready && this.fork) {
      await this.stop()
    }
  }

  /**
   * Updates entry options and reconciles running state.
   *
   * @param options New partial or complete options to apply.
   * @param override If `true`, replaces options entirely; otherwise merges non-nullish fields.
   */
  async update(options: Partial<EntryOptions>, override = false) {
    const legacy = { ...this.options }

    // Step 1: Merge or replace options
    if (override) {
      this.options = options as EntryOptions
    } else {
      for (const [key, value] of Object.entries(options)) {
        if (isNullable(value)) {
          delete this.options[key]
        } else {
          this.options[key] = value
        }
      }
    }
    sortKeys(this.options)

    // Step 2: Apply changes based on readiness check
    if (!this._check()) {
      await this.stop()
    } else if (this.fork) {
      this.context.emit('loader/partial-dispose', this, legacy, true)
      this.patch(options)
    } else {
      await this.start()
    }
  }

  /**
   * Dynamically imports the plugin module, initializes the context, and launches the plugin fork.
   */
  async start() {
    const exports = await this.parent.tree.import(this.options.name).catch((error: any) => {
      this.context.emit(this.ctx, 'internal/error', new Error(`Cannot find package "${this.options.name}"`))
      this.context.emit(this.ctx, 'internal/error', error)
    })
    if (!exports) return
    const plugin = this.loader.unwrapExports(exports)
    this.patch()
    this.ctx[Entry.key] = this
    const [config, error] = this._resolveConfig(plugin)
    this.fork = this.ctx.registry.plugin(plugin, config, error)
    this.context.emit('loader/entry-fork', this, 'apply')
  }

  /**
   * Stops and disposes the running plugin fork.
   */
  async stop() {
    this.fork?.dispose()
    this.fork = undefined
  }
}
