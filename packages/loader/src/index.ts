import Module from 'node:module'
import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { Loader } from './loader.ts'
import * as dotenv from 'dotenv'
import * as path from 'node:path'

export * from './internal.ts'
export * from './loader.ts'

/**
 * Signature for Node.js internal `Module._load` method.
 */
type ModuleLoad = (request: string, parent: Module, isMain: boolean) => any

/**
 * Snapshot of the initial environment variables at process startup time.
 *
 * Preserved to allow resetting `process.env` back to its pristine state
 * before re-applying `.env` and `.env.local` files during `init()`.
 */
const oldEnv = { ...process.env }

namespace NodeLoader {
  /**
   * Configuration options for {@link NodeLoader}.
   */
  export interface Config extends Loader.Config {}
}

/**
 * Node.js-specific implementation of the Cordis {@link Loader}.
 *
 * Handles:
 * - Environment variable restoration and `.env` / `.env.local` file overrides.
 * - Synchronous CommonJS-to-ESM module resolution via Node's internal `Module._load` hook.
 * - Process exit and full reload signaling with persistent runtime data via IPC.
 */
class NodeLoader extends Loader {
  /**
   * Default process exit code indicating a request for supervisor-managed full reload.
   */
  static readonly exitCode = 51

  /**
   * Initializes the Node.js loader environment in the specified base directory.
   *
   * Resets `process.env` to its initial snapshot, parses `.env` and `.env.local`
   * files located in `ctx.baseDir`, and merges them into `process.env`.
   *
   * @param baseDir The root directory of the application.
   * @param options Configuration options for the loader.
   */
  async init(baseDir: string, options: Loader.Config) {
    await super.init(baseDir, options)

    // Step 1: Restore process.env to the initial startup state
    for (const key in process.env) {
      if (key in oldEnv) {
        process.env[key] = oldEnv[key]
      } else {
        delete process.env[key]
      }
    }

    // Step 2: Load and parse .env and .env.local files (.env.local has higher priority)
    const override = {}
    const envFiles = ['.env', '.env.local']
    for (const filename of envFiles) {
      try {
        const raw = await readFile(path.resolve(this.ctx.baseDir, filename), 'utf8')
        Object.assign(override, dotenv.parse(raw))
      } catch {
        // Ignore missing or unreadable environment files
      }
    }

    // Step 3: Apply parsed environment overrides to process.env
    for (const key in override) {
      process.env[key] = override[key]
    }
  }

  /**
   * Starts the loader and installs Node.js module loading interop hooks.
   *
   * Monkey-patches `Module._load` to catch `ERR_REQUIRE_ESM` errors when CommonJS code
   * synchronously requires an ES module, delegating resolution to the internal ModuleLoader.
   */
  async start() {
    const originalLoad: ModuleLoad = Module['_load']
    Module['_load'] = ((request, parent, isMain) => {
      try {
        return originalLoad(request, parent, isMain)
      } catch (e: any) {
        // Intercept ERR_REQUIRE_ESM errors if an internal module loader hook is present
        if (e.code !== 'ERR_REQUIRE_ESM' || !this.internal) throw e
        try {
          // TODO support hmr for cjs-esm interop
          const result = this.internal.resolveSync(request, pathToFileURL(parent.filename).href, {})
          const job = result?.format === 'module'
            ? this.internal.loadCache.get(result.url)
            : undefined
          if (job) return job?.module?.getNamespace()
        } catch {
          throw e
        }
      }
    }) as ModuleLoad

    await super.start()
  }

  /**
   * Terminates the current process, optionally notifying a parent supervisor process.
   *
   * Serializes `envData` and transmits it via IPC `process.send` before exiting,
   * allowing shared runtime state (such as start time) to survive reloads.
   *
   * @param code The process exit code (defaults to {@link NodeLoader.exitCode}).
   */
  exit(code = NodeLoader.exitCode) {
    const body = JSON.stringify(this.envData)
    process.send?.({ type: 'shared', body }, (err: any) => {
      if (err) this.ctx.emit(this.ctx, 'internal/error', 'failed to send shared data')
      this.ctx.emit(this.ctx, 'internal/info', 'trigger full reload')
      process.exit(code)
    })
  }
}

export default NodeLoader
