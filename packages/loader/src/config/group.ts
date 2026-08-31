import { Context } from '@cordisjs/core'
import { Entry, EntryOptions } from './entry.ts'
import { EntryTree } from './tree.ts'

/**
 * Manages an ordered list of configuration entries representing a logical plugin group.
 *
 * Provides:
 * - Entry allocation, parenting, and removal.
 * - Diff-based reconciliation when group configuration updates.
 * - Unlinking entries when moved or deleted.
 */
export class EntryGroup {
  /** Symbol used to mark group plugin definitions. */
  static readonly key = Symbol.for('cordis.group')

  /** The ordered array of entry options contained within this group. */
  public data: EntryOptions[] = []

  /**
   * Creates a new EntryGroup container.
   *
   * @param ctx The context for this group.
   * @param tree The enclosing {@link EntryTree}.
   */
  constructor(public ctx: Context, public tree: EntryTree) {
    const entry = ctx.scope.entry
    if (entry) entry.subgroup = this
  }

  /**
   * Creates or updates a child entry within this group.
   *
   * @param options Entry options (without ID or with optional ID).
   * @returns Promise resolving to the entry ID.
   */
  async create(options: Omit<EntryOptions, 'id'>) {
    const id = this.tree.ensureId(options)
    const entry = this.tree.store[id] ??= new Entry(this.ctx.loader)
    // Entry may be moved from another group,
    // so we need to update the parent reference.
    entry.parent = this
    await entry.update(options, true)
    return entry.id
  }

  /**
   * Unlinks an entry's options from the group's data array without stopping its fork.
   *
   * @param options The entry options to unlink.
   */
  unlink(options: EntryOptions) {
    const config = this.data
    const index = config.indexOf(options)
    if (index >= 0) config.splice(index, 1)
  }

  /**
   * Disposes and deletes an entry by ID, unlinking it and notifying listeners.
   *
   * @param id The ID of the entry to remove.
   */
  remove(id: string) {
    const entry = this.tree.store[id]
    if (!entry) return
    entry.stop()
    this.unlink(entry.options)
    delete this.tree.store[id]
    this.ctx.emit('loader/partial-dispose', entry, entry.options, false)
  }

  /**
   * Reconciles child entries with a new configuration list.
   *
   * Creates newly added entries, updates existing entries, and removes omitted entries.
   *
   * @param config The updated array of entry options.
   */
  update(config: EntryOptions[]) {
    const oldConfig = this.data as EntryOptions[]
    this.data = config
    const oldMap = Object.fromEntries(oldConfig.map(options => [options.id, options]))
    const newMap = Object.fromEntries(config.map(options => [options.id ?? Symbol('anonymous'), options]))

    // Update inner plugins by comparing old and new entry IDs
    for (const id of Reflect.ownKeys({ ...oldMap, ...newMap }) as string[]) {
      if (newMap[id]) {
        this.create(newMap[id]).catch((error) => {
          this.ctx.emit(this.ctx, 'internal/error', error)
        })
      } else {
        this.remove(id)
      }
    }
  }

  /**
   * Stops and removes all entries contained in this group.
   */
  stop() {
    for (const options of this.data) {
      this.remove(options.id)
    }
  }
}

/**
 * Cordis plugin implementation of {@link EntryGroup}.
 *
 * Allows groups of plugins to be loaded as reusable sub-configurations
 * that dynamically react to config updates.
 */
export class Group extends EntryGroup {
  /** Marks the plugin as reusable so multiple group instances can run concurrently. */
  static reusable = true

  /** Initial default configuration entries. */
  static initial: Omit<EntryOptions, 'id'>[] = []

  /** Marker identifying this plugin as a group plugin. */
  static readonly [EntryGroup.key] = true

  /**
   * Initializes a Group plugin instance and hooks into lifecycle / config updates.
   *
   * @param ctx The scoped context for the group plugin.
   */
  constructor(public ctx: Context) {
    super(ctx, ctx.scope.entry!.parent.tree)
    ctx.on('dispose', () => this.stop())
    ctx.accept((config: EntryOptions[]) => {
      this.update(config)
    }, { passive: true, immediate: true })
  }
}
