import { Context, ForkScope, MainScope, Plugin, Schema, Service } from 'cordis'
import { Dict, makeArray } from 'cosmokit'
import { ModuleJob, ModuleLoader } from 'cordis/loader'
import { FSWatcher, watch, WatchOptions } from 'chokidar'
import { relative, resolve } from 'path'
import { handleError } from './error.ts'
import {} from '@cordisjs/timer'
import { fileURLToPath, pathToFileURL } from 'url'
import enUS from './locales/en-US.yml'
import zhCN from './locales/zh-CN.yml'

declare module 'cordis' {
  interface Context {
    /**
     * Hot Module Replacement (HMR) service instance.
     */
    hmr: Watcher
  }

  interface Events {
    /**
     * Emitted after a successful hot module reload of one or more plugins.
     *
     * @param reloads - Map of old plugin definitions to their reload metadata and restored fork scopes.
     */
    'hmr/reload'(reloads: Map<Plugin, Reload>): void
  }
}

/**
 * Recursively traverses and collects all module dependencies linked to a {@link ModuleJob}.
 *
 * Traversal ignores:
 * - Module URLs already in the `ignored` set.
 * - Module URLs already visited in `dependencies`.
 * - Node.js built-in modules (e.g. `node:*`).
 * - Third-party packages inside `/node_modules/`.
 *
 * @param job - The root module job to start dependency discovery from.
 * @param ignored - Optional set of module URLs to skip during traversal.
 * @returns A promise resolving to the set of all collected module URLs.
 */
async function loadDependencies(job: ModuleJob, ignored = new Set<string>()) {
  const dependencies = new Set<string>()
  async function traverse(job: ModuleJob) {
    if (ignored.has(job.url) || dependencies.has(job.url) || job.url.startsWith('node:') || job.url.includes('/node_modules/')) return
    dependencies.add(job.url)
    const children = await job.linked
    await Promise.all(Array.prototype.map.call(children, traverse))
  }
  await traverse(job)
  return dependencies
}

/**
 * Metadata representing a plugin reload task.
 */
interface Reload {
  /** The module URL or filename of the plugin entry point. */
  filename: string
  /** The array of active fork scopes that need to be re-instantiated with the reloaded plugin. */
  children: ForkScope[]
}

/**
 * Hot Module Replacement (HMR) Watcher Service for Cordis.
 *
 * Watches the file system for source code and configuration changes using `chokidar`,
 * performs dependency graph analysis through the Node.js module loader hooks (`ModuleLoader`),
 * and orchestrates atomic plugin reloads while preserving configurations and fork states.
 */
class Watcher extends Service {
  /** Required dependencies injected by the Cordis context. */
  static inject = ['loader']

  /** Resolved absolute base directory path for relative path resolution and file watching. */
  private base: string

  /** Internal module loader instance exposed by Node via `--expose-internals`. */
  private internal: ModuleLoader

  /** File system watcher instance from chokidar. */
  private watcher!: FSWatcher

  /**
   * Set of module URLs considered "external" core dependencies (e.g., `cordis/worker` and its runtime graph).
   *
   * Changes to any file in `externals` cannot be hot-swapped safely in-place and will trigger a full process restart:
   * - root R -> external E -> none of plugin Q
   */
  private externals!: Set<string>

  /**
   * Set of module URLs that have been analyzed and accepted for hot reloading.
   *
   * - Includes all stashed changed files S
   * - some plugin P -> file X -> some change C
   */
  private accepted!: Set<string>

  /**
   * Set of module URLs that should not be reloaded.
   *
   * - Includes all externals E
   * - some change C -> file X -> none of change D
   */
  private declined!: Set<string>

  /**
   * Set of changed file URLs accumulated since the last reload cycle.
   */
  private stashed = new Set<string>()

  /**
   * Constructs a new HMR Watcher service instance.
   *
   * @param ctx - The Cordis context to bind this service to.
   * @param config - The watcher configuration options.
   * @throws Error if Node was not started with `--expose-internals` (required for loader hooks).
   */
  constructor(ctx: Context, public config: Watcher.Config) {
    super(ctx, 'hmr')
    if (!this.ctx.loader.internal) {
      throw new Error('--expose-internals is required for HMR service')
    }
    this.internal = this.ctx.loader.internal
    this.base = resolve(ctx.baseDir, config.base || '')
  }

  /**
   * Computes the relative path of a given filename with respect to the watcher's base directory.
   *
   * @param filename - Absolute or relative path of the file.
   * @returns Relative path if base is defined; otherwise the original filename.
   */
  relative(filename: string) {
    if (!this.base) return filename
    return relative(this.base, filename)
  }

  /**
   * Initializes file watchers and starts monitoring for module and configuration changes.
   *
   * Lifecycle actions:
   * 1. Starts chokidar file watcher on configured root paths with ignored patterns.
   * 2. Inspects `cordis/worker` module job to determine non-reloadable external dependencies.
   * 3. Sets up debounced change listener to handle file modifications:
   *    - External file change -> triggers full process exit via `loader.exit()`.
   *    - Cached module file change -> stashes URL and schedules local reload.
   *    - Config/tree file change -> refreshes config tree (unless suspended).
   */
  async start() {
    const { loader } = this.ctx
    const { root, ignored } = this.config
    this.watcher = watch(root, {
      ...this.config,
      cwd: this.base,
      ignored: makeArray(ignored),
    })

    // files independent from any plugins will trigger a full reload
    const mainJob = await loader.internal!.getModuleJob('cordis/worker', import.meta.url, {})!
    this.externals = await loadDependencies(mainJob)
    const triggerLocalReload = this.ctx.debounce(() => this.triggerLocalReload(), this.config.debounce)

    this.watcher.on('change', async (path) => {
      this.ctx.logger.debug('change detected:', path)
      const url = pathToFileURL(resolve(this.base, path)).href
      if (this.externals.has(url)) return loader.exit()

      if (loader.internal!.loadCache.has(url)) {
        this.stashed.add(url)
        return triggerLocalReload()
      }

      const file = this.ctx.loader.files[url]
      if (!file) return
      if (file.suspend) {
        file.suspend = false
        return
      }
      for (const tree of file.trees) {
        tree.refresh()
      }
    })
  }

  /**
   * Stops the file watcher and releases resources.
   */
  async stop() {
    return await this.watcher.close()
  }

  /**
   * Retrieves the absolute file paths of all modules linked/imported by the given module.
   *
   * Queries the loader's `loadCache` for the corresponding {@link ModuleJob} and resolves
   * each linked job's URL back to a file path.
   *
   * @param filename - Absolute file path of the module to query.
   * @returns A promise resolving to an array of linked file paths.
   */
  async getLinked(filename: string) {
    // The second parameter `type` should always be `javascript`.
    const job = this.internal.loadCache.get(pathToFileURL(filename).toString())
    if (!job) return []
    const linked = await job.linked
    return linked.map(job => fileURLToPath(job.url))
  }

  /**
   * Propagates changes across the module dependency graph to classify modules as `accepted` or `declined`.
   *
   * Classification algorithm:
   * 1. Initializes `accepted` with all stashed modified files, and `declined` with external core files.
   * 2. Inspects direct and transitive linked children of stashed files.
   * 3. Iteratively evaluates pending modules until closure:
   *    - If any linked child of a module is accepted, the module is marked `accepted`.
   *    - If all linked children of a module are declined, the module is marked `declined`.
   *    - Modules with undecided dependencies remain in `pending` for subsequent passes.
   * 4. Any modules remaining unresolvable after graph convergence are marked `declined`.
   */
  private async analyzeChanges() {
    /** files pending classification */
    const pending: string[] = []

    this.accepted = new Set(this.stashed)
    this.declined = new Set(this.externals)

    await Promise.all([...this.stashed].map(async (filename) => {
      const children = await this.getLinked(filename)
      for (const filename of children) {
        if (this.accepted.has(filename) || this.declined.has(filename) || filename.includes('/node_modules/')) continue
        pending.push(filename)
      }
    }))

    while (pending.length) {
      let index = 0, hasUpdate = false
      while (index < pending.length) {
        const filename = pending[index]
        const children = await this.getLinked(filename)
        let isDeclined = true, isAccepted = false
        for (const filename of children) {
          // ignore all declined children
          if (this.declined.has(filename) || filename.includes('/node_modules/')) continue
          if (this.accepted.has(filename)) {
            // mark the module as accepted if any child is accepted
            isAccepted = true
            break
          } else {
            // the child module is neither accepted nor declined
            // so we need to perform further analysis
            isDeclined = false
            if (!pending.includes(filename)) {
              hasUpdate = true
              pending.push(filename)
            }
          }
        }
        if (isAccepted || isDeclined) {
          hasUpdate = true
          pending.splice(index, 1)
          if (isAccepted) {
            this.accepted.add(filename)
          } else {
            // mark the module as declined if all children are declined
            this.declined.add(filename)
          }
        } else {
          index++
        }
      }
      // infinite loop
      if (!hasUpdate) break
    }

    for (const filename of pending) {
      this.declined.add(filename)
    }
  }

  /**
   * Executes the local hot reload workflow for affected plugins.
   *
   * Step-by-step workflow:
   * 1. **Change Analysis**: Invokes {@link analyzeChanges} to classify modified/affected modules.
   * 2. **Plugin Discovery**: Resolves active loader entries to identify candidate plugin entry jobs.
   * 3. **Impact Detection**: Traverses dependency trees of plugins to see if any depend on `accepted` files.
   * 4. **Fork Tracking**: Records active {@link ForkScope}s under each plugin's {@link MainScope} runtime.
   * 5. **Cache Backup & Invalidation**: Backs up and deletes `accepted` modules from `internal.loadCache`.
   * 6. **Re-import**: Dynamically re-imports modified plugin modules. On compilation error, invokes {@link handleError} and rolls back cache.
   * 7. **Plugin Replacement**:
   *    - Disposes old plugin from `ctx.registry`.
   *    - Re-instantiates each fork scope using the new plugin export and previous config/entry references.
   *    - If re-instantiation fails, rolls back both module cache and previous plugin instances.
   * 8. **Event Notification**: Emits the `'hmr/reload'` event and clears `stashed` files.
   */
  private async triggerLocalReload() {
    await this.analyzeChanges()

    /** plugins pending classification */
    const pending = new Map<ModuleJob, [Plugin, MainScope | undefined]>()

    /** plugins that should be reloaded */
    const reloads = new Map<Plugin, Reload>()

    // Plugin entry files should be "atomic".
    // Which means, reloading them will not cause any other reloads.
    const nameMap: Dict<Set<string>> = Object.create(null)
    for (const entry of this.ctx.loader.entries()) {
      (nameMap[entry.parent.tree.url] ??= new Set()).add(entry.options.name)
    }
    for (const baseURL in nameMap) {
      for (const name of nameMap[baseURL]) {
        try {
          const { url } = await this.internal.resolve(name, baseURL, {})
          if (this.declined.has(url)) continue
          const job = this.internal.loadCache.get(url)
          const plugin = this.ctx.loader.unwrapExports(job?.module?.getNamespace())
          const runtime = this.ctx.registry.get(plugin)
          if (!job || !plugin) continue
          pending.set(job, [plugin, runtime])
          this.declined.add(url)
        } catch (err) {
          this.ctx.logger.warn(err)
        }
      }
    }

    for (const [job, [plugin, runtime]] of pending) {
      // check if it is a dependent of the changed file
      this.declined.delete(job.url)
      const dependencies = [...await loadDependencies(job, this.declined)]
      this.declined.add(job.url)

      // we only detect reloads at plugin level
      // a plugin will be reloaded if any of its dependencies are accepted
      if (!dependencies.some(dep => this.accepted.has(dep))) continue
      dependencies.forEach(dep => this.accepted.add(dep))

      // prepare for reload
      if (runtime) {
        let isMarked = false
        const visited = new Set<MainScope>()
        const queued = [runtime]
        while (queued.length) {
          const runtime = queued.shift()!
          if (visited.has(runtime)) continue
          visited.add(runtime)
          if (reloads.has(plugin)) {
            isMarked = true
            break
          }
          for (const fork of runtime.children) {
            queued.push(fork.runtime)
          }
        }
        if (!isMarked) {
          const children: ForkScope[] = []
          reloads.set(plugin, { filename: job.url, children })
          for (const fork of runtime.children) {
            children.push(fork)
          }
        }
      } else {
        reloads.set(plugin, { filename: job.url, children: [] })
      }
    }

    // save cache for rollback
    // and delete cache before re-import
    const backup: Dict = Object.create(null)
    for (const filename of this.accepted) {
      const job = Map.prototype.get.call(this.internal.loadCache, filename)
      backup[filename] = job
      Map.prototype.delete.call(this.internal.loadCache, filename)
    }

    /** rollback cache */
    const rollback = () => {
      for (const filename in backup) {
        Map.prototype.set.call(this.internal.loadCache, filename, backup[filename])
      }
    }

    // attempt to load entry files
    const attempts: Dict = {}
    try {
      for (const [, { filename }] of reloads) {
        attempts[filename] = this.ctx.loader.unwrapExports(await import(filename))
      }
    } catch (e) {
      handleError(this.ctx, e)
      return rollback()
    }

    const reload = (plugin: any, children: ForkScope[]) => {
      for (const oldFork of children) {
        const fork = oldFork.parent.plugin(plugin, oldFork.config)
        fork.entry = oldFork.entry
        if (fork.entry) fork.entry.fork = fork
      }
    }

    try {
      for (const [plugin, { filename, children }] of reloads) {
        const path = this.relative(fileURLToPath(filename))

        try {
          this.ctx.registry.delete(plugin)
        } catch (err) {
          this.ctx.logger.warn('failed to dispose plugin at %c', path)
          this.ctx.logger.warn(err)
        }

        try {
          reload(attempts[filename], children)
          this.ctx.logger.info('reload plugin at %c', path)
        } catch (err) {
          this.ctx.logger.warn('failed to reload plugin at %c', path)
          this.ctx.logger.warn(err)
          throw err
        }
      }
    } catch {
      // rollback cache and plugin states
      rollback()
      for (const [plugin, { filename, children }] of reloads) {
        try {
          this.ctx.registry.delete(attempts[filename])
          reload(plugin, children)
        } catch (err) {
          this.ctx.logger.warn(err)
        }
      }
      return
    }

    // emit reload event on success
    this.ctx.emit('hmr/reload', reloads)

    // reset stashed files
    this.stashed = new Set()
  }
}

namespace Watcher {
  /**
   * Configuration options for the {@link Watcher} service.
   */
  export interface Config extends WatchOptions {
    /** Base directory path for resolving relative file paths. */
    base?: string
    /** Root directories or files to watch. */
    root: string[]
    /** Debounce interval in milliseconds for batching file change events. */
    debounce: number
    /** File glob patterns to ignore from watching and reloading. */
    ignored: string[]
  }

  /**
   * Cordis schema definition for {@link Watcher.Config}.
   */
  export const Config: Schema<Config> = Schema.object({
    base: Schema.string(),
    root: Schema.union([
      Schema.array(String).role('table'),
      Schema.transform(String, (value) => [value]),
    ]).default(['.']),
    ignored: Schema.union([
      Schema.array(String).role('table'),
      Schema.transform(String, (value) => [value]),
    ]).default([
      '**/node_modules/**',
      '**/.git/**',
      '**/logs/**',
    ]),
    debounce: Schema.natural().role('ms').default(100),
  }).i18n({
    'en-US': enUS,
    'zh-CN': zhCN,
  })
}

export default Watcher

