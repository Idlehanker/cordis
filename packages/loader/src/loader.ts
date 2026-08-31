import { Context, EffectScope } from '@cordisjs/core'
import { Dict, isNullable } from 'cosmokit'
import { ModuleLoader } from './internal.ts'
import { Entry, EntryOptions, EntryUpdateMeta } from './config/entry.ts'
import { LoaderFile } from './config/file.ts'
import { ImportTree } from './config/import.ts'
import * as inject from './config/inject.ts'
import * as isolate from './config/isolate.ts'

export * from './config/entry.ts'
export * from './config/file.ts'
export * from './config/group.ts'
export * from './config/import.ts'
export * from './config/tree.ts'

declare module '@cordisjs/core' {
  interface Events {
    /** Emitted when a process termination signal (e.g. SIGINT, SIGTERM) is received. */
    'exit'(signal: NodeJS.Signals): Promise<void>
    /** Emitted when configuration changes have been written to the backing file. */
    'loader/config-update'(): void
    /** Emitted when a new {@link Entry} instance is created and initialized. */
    'loader/entry-init'(entry: Entry): void
    /**
     * Emitted when a plugin fork lifecycle event occurs.
     *
     * @param entry The associated entry instance.
     * @param type The lifecycle action ('apply' | 'reload' | 'unload').
     */
    'loader/entry-fork'(entry: Entry, type: string): void
    /**
     * Evaluated in bail mode to determine whether an entry is eligible to be started.
     *
     * Returning `true` or any truthy value indicates the entry should NOT start.
     *
     * @param entry The entry to validate.
     */
    'loader/entry-check'(entry: Entry): boolean | undefined
    /**
     * Emitted when an entry is being partially reconfigured or removed, allowing plugins
     * (such as isolation realms) to perform cleanup tasks.
     *
     * @param entry The target entry.
     * @param legacy The previous options before update or removal.
     * @param active Whether the entry remains active after the partial update.
     */
    'loader/partial-dispose'(entry: Entry, legacy: Partial<EntryOptions>, active: boolean): void
    /**
     * Emitted before patching an entry's context and fork configuration.
     *
     * @param entry The entry being patched.
     */
    'loader/before-patch'(this: EntryUpdateMeta, entry: Entry): void
    /**
     * Emitted after patching an entry's context and fork configuration.
     *
     * @param entry The entry being patched.
     */
    'loader/after-patch'(this: EntryUpdateMeta, entry: Entry): void
  }

  interface Context {
    /** The base directory of the project. */
    baseDir: string
    /** Reference to the active {@link Loader} instance. */
    loader: Loader<this>
  }

  interface EnvData {
    /** Application start timestamp (preserved across process reloads). */
    startTime?: number
  }

  // Theoretically, these properties will only appear on `ForkScope`.
  // We define them directly on `EffectScope` for typing convenience.
  interface EffectScope {
    /** The configuration entry associated with this effect scope, if managed by the loader. */
    entry?: Entry
  }
}

export namespace Loader {
  /**
   * Initialization configuration for the {@link Loader}.
   */
  export interface Config {
    /** Base filename without extension (e.g. `'cordis'`, `'koishi'`). */
    name: string
    /** Initial configuration entries written to file if none exists. */
    initial?: Omit<EntryOptions, 'id'>[]
    /** Explicit file path or directory for the configuration file. */
    filename?: string
  }
}

/**
 * Abstract base class for the Cordis configuration loader.
 *
 * Coordinates:
 * - Loading, parsing, and writing configuration files.
 * - Instantiating, updating, and disposing plugins from configuration entries.
 * - Dynamic dependency injection (`inject`) and service isolation (`isolate`).
 * - Tracking plugin fork lifecycles and self-disposal synchronization.
 *
 * @template C The Context type.
 */
export abstract class Loader<C extends Context = Context> extends ImportTree<C> {
  // TODO auto inject optional when provided?
  static inject = {
    loader: { required: false },
  }

  /**
   * Runtime environment data shared across process reload cycles via `process.env.CORDIS_SHARED`.
   */
  public envData = process.env.CORDIS_SHARED
    ? JSON.parse(process.env.CORDIS_SHARED)
    : { startTime: Date.now() }

  /**
   * Process parameters exposed to the context.
   */
  public params = {
    env: process.env,
  }

  /** Cache mapping file URL strings to their {@link LoaderFile} instances. */
  public files: Dict<LoaderFile> = Object.create(null)

  /** Cache mapping service keys to their isolation delimiter symbols. */
  public delims: Dict<symbol> = Object.create(null)

  /** Optional internal ESM module loader instance. */
  public internal?: ModuleLoader

  /**
   * Creates a new Loader instance and attaches lifecycle event listeners.
   *
   * @param ctx The root context instance.
   * @param config Loader configuration options.
   */
  constructor(public ctx: C, public config: Loader.Config) {
    super(ctx)

    ctx.set('loader', this)

    // Notify when a plugin fork updates (e.g. schema validation or runtime reload)
    ctx.on('internal/update', (fork) => {
      if (!fork.entry) return
      fork.parent.emit('loader/entry-fork', fork.entry, 'reload')
    })

    // Synchronize simplified configuration back into entry options and persist to disk
    ctx.on('internal/before-update', (fork, config) => {
      if (!fork.entry) return
      if (fork.entry.suspend) return fork.entry.suspend = false
      const { schema } = fork.runtime
      fork.entry.options.config = schema ? schema.simplify(config) : config
      fork.entry.parent.tree.write()
    })

    // Track plugin fork creation and handle self-disposal events
    ctx.on('internal/fork', (fork) => {
      // 1. Link fork to its entry if created from an entry context
      if (fork.parent[Entry.key]) {
        fork.entry = fork.parent[Entry.key]
        delete fork.parent[Entry.key]
      }

      // 2. Handle self-disposal
      // We only care about `ctx.scope.dispose()`, so we need to filter out other cases.

      // Case 1: Fork was just created (has non-zero uid)
      if (fork.uid) return

      // Case 2: Fork is not tracked by loader
      if (!fork.entry) return

      // Case 3: Fork is disposed on behalf of plugin deletion (such as plugin HMR)
      // self-dispose: ctx.scope.dispose() -> fork / runtime dispose -> delete(plugin)
      // plugin HMR: delete(plugin) -> runtime dispose -> fork dispose
      if (!ctx.registry.has(fork.runtime.plugin)) return

      fork.entry.fork = undefined
      fork.parent.emit('loader/entry-fork', fork.entry, 'unload')

      // Case 4: Fork is disposed by loader behavior
      // such as inject checker, config file update, ancestor group disable
      if (!fork.entry._check()) return

      // Plugin disposed itself at runtime; mark disabled and persist change
      fork.entry.options.disabled = true
      fork.entry.parent.tree.write()
    })

    // Install built-in loader plugins for service injection and isolation
    ctx.plugin(inject)
    ctx.plugin(isolate)
  }

  /**
   * Starts the loader by initializing the configuration file from current working directory
   * and starting the root import tree.
   */
  async start() {
    await this.init(process.cwd(), this.config)
    this.ctx.set('env', process.env)
    await super.start()
  }

  /**
   * Resolves the list of active entry IDs associated with the specified context.
   *
   * @param ctx The context to inspect (defaults to `this.ctx`).
   * @returns Array of matching entry IDs.
   */
  locate(ctx = this.ctx) {
    return this._locate(ctx.scope).map(entry => entry.id)
  }

  /**
   * Recursively locates entries corresponding to the given effect scope.
   *
   * @param scope The effect scope to locate entries for.
   * @returns Array of associated {@link Entry} instances.
   */
  _locate(scope: EffectScope<C>): Entry[] {
    // Root scope without plugin
    if (!scope.runtime.plugin) return []

    // Runtime scope with children forks
    if (scope.runtime === scope) {
      return scope.runtime.children.flatMap(child => this._locate(child))
    }

    if (scope.entry) return [scope.entry]
    return this._locate(scope.parent.scope)
  }

  /**
   * Hook called when the loader process is exiting. Can be overridden by runtime loaders.
   */
  exit() {}

  /**
   * Unwraps default exports and resolves esbuild module interop wrappers.
   *
   * @param exports The imported module exports object.
   * @returns The unwrapped plugin object or function.
   */
  unwrapExports(exports: any) {
    if (isNullable(exports)) return exports
    exports = exports.default ?? exports
    // https://github.com/evanw/esbuild/issues/2623
    // https://esbuild.github.io/content-types/#default-interop
    if (!exports.__esModule) return exports
    return exports.default ?? exports
  }
}

export default Loader
