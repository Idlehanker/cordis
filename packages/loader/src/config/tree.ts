import { Context } from '@cordisjs/core'
import { Dict } from 'cosmokit'
import { Entry, EntryOptions } from './entry.ts'
import { EntryGroup } from './group.ts'

/**
 * Abstract tree structure managing hierarchical configuration entries.
 *
 * Coordinates:
 * - Storing and indexing entries by ID.
 * - Resolving colon-delimited hierarchical entry IDs across nested subtrees (`parent:child`).
 * - Generating unique random entry IDs.
 * - CRUD operations for entries and groups with automatic config persistence.
 * - Delegating module imports to either internal ESM module loader or native dynamic import.
 *
 * @template C The Context subtype.
 */
export abstract class EntryTree<C extends Context = Context> {
  /** Separator character used in hierarchical entry paths. */
  static readonly sep = ':'

  /** The file URL corresponding to this tree. */
  public url!: string

  /** The root {@link EntryGroup} of this tree. */
  public root: EntryGroup

  /** Dictionary storing all entries directly contained within this tree by their local ID. */
  public store: Dict<Entry<C>> = Object.create(null)

  /**
   * Creates an EntryTree instance.
   *
   * @param ctx The context for this tree.
   */
  constructor(public ctx: C) {
    this.root = new EntryGroup(ctx, this)
    const entry = ctx.scope.entry
    if (entry) entry.subtree = this
  }

  /**
   * The context instance associated with this tree.
   */
  get context(): Context {
    return this.ctx
  }

  /**
   * Recursively yields all {@link Entry} instances across this tree and any nested subtrees.
   */
  * entries(): Generator<Entry<C>, void, void> {
    for (const entry of Object.values(this.store)) {
      yield entry
      if (!entry.subtree) continue
      yield* entry.subtree.entries()
    }
  }

  /**
   * Ensures an entry options object has a unique local ID, generating a 6-character random ID if omitted.
   *
   * @param options The entry options to validate or populate.
   * @returns The resolved ID string.
   */
  ensureId(options: Partial<EntryOptions>) {
    if (!options.id) {
      do {
        options.id = Math.random().toString(36).slice(2, 8)
      } while (this.store[options.id])
    }
    return options.id!
  }

  /**
   * Resolves an entry across the tree hierarchy using a colon-delimited ID path.
   *
   * @param id Hierarchical entry path (e.g. `"subgroup:plugin"`).
   * @returns The resolved {@link Entry}.
   * @throws If the path cannot be resolved.
   */
  resolve(id: string) {
    const parts = id.split(EntryTree.sep)
    let tree: EntryTree | undefined = this
    const final = parts.pop()!
    for (const part of parts) {
      tree = tree.store[part]?.subtree
      if (!tree) throw new Error(`cannot resolve entry ${id}`)
    }
    const entry = tree.store[final]
    if (!entry) throw new Error(`cannot resolve entry ${id}`)
    return entry
  }

  /**
   * Resolves a target {@link EntryGroup} by ID (or returns the root group if ID is null).
   *
   * @param id The group entry ID, or `null` for root group.
   * @returns The resolved {@link EntryGroup}.
   * @throws If the entry does not exist or is not a group container.
   */
  resolveGroup(id: string | null) {
    if (!id) return this.root
    const entry = this.resolve(id)
    if (!entry.subgroup) throw new Error(`entry ${id} is not a group`)
    return entry.subgroup
  }

  /**
   * Creates a new entry options record in the specified parent group, saves configuration, and starts the entry.
   *
   * @param options Entry options (without ID).
   * @param parent Target parent group ID (or `null` for root group).
   * @param position Zero-based insertion index in group data (defaults to append).
   * @returns Promise resolving to the entry ID.
   */
  async create(options: Omit<EntryOptions, 'id'>, parent: string | null = null, position = Infinity) {
    const group = this.resolveGroup(parent)
    group.data.splice(position, 0, options as EntryOptions)
    group.tree.write()
    return group.create(options)
  }

  /**
   * Removes an entry by ID from its parent group and writes configuration changes.
   *
   * @param id Hierarchical entry ID to remove.
   */
  remove(id: string) {
    const entry = this.resolve(id)
    entry.parent.remove(id)
    entry.parent.tree.write()
  }

  /**
   * Updates an existing entry's options and optionally moves it to a new parent group or position.
   *
   * @param id Hierarchical entry ID to update.
   * @param options New options to apply (excluding ID and name).
   * @param parent Optional new parent group ID (`null` for root group).
   * @param position Optional new position within the target parent group.
   */
  async update(id: string, options: Omit<EntryOptions, 'id' | 'name'>, parent?: string | null, position?: number) {
    const entry = this.resolve(id)
    const source = entry.parent
    if (parent !== undefined) {
      const target = this.resolveGroup(parent)
      source.unlink(entry.options)
      target.data.splice(position ?? Infinity, 0, entry.options)
      target.tree.write()
      entry.parent = target
    }
    source.tree.write()
    return entry.update(options)
  }

  /**
   * Dynamically imports a module by name/specifier.
   *
   * Uses the loader's internal ESM ModuleLoader if available, falling back to native `import()`.
   *
   * @param name Module specifier or file path.
   * @returns Promise resolving to the imported module namespace.
   */
  async import(name: string) {
    if (this.ctx.loader.internal) {
      return this.ctx.loader.internal.import(name, this.url, {})
    } else {
      return import(name)
    }
  }

  /**
   * Persists configuration changes back to the backing storage.
   */
  abstract write(): void
}
