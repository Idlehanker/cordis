import { LoadHookContext } from 'module'
import { Dict } from 'cosmokit'

/**
 * Recognized module format types for module resolution and loading.
 */
type ModuleFormat = 'builtin' | 'commonjs' | 'json' | 'module' | 'wasm'

/**
 * Raw module source content, either as a UTF-8 string or binary ArrayBuffer.
 */
type ModuleSource = string | ArrayBuffer

/**
 * Result returned from resolving a module specifier.
 */
interface ResolveResult {
  /** The module format determined during resolution. */
  format: ModuleFormat
  /** The fully qualified file/package URL string of the resolved module. */
  url: string
}

/**
 * Result returned from loading a module's content.
 */
interface LoadResult {
  /** The module format. */
  format: ModuleFormat
  /** The raw source code or buffer if available. */
  source?: ModuleSource
}

/**
 * Cached module job representation in the module loader cache.
 */
type LoadCacheData = ModuleJob // | Function

/**
 * Module cache mapping URL strings and optional types to their corresponding {@link ModuleJob}.
 */
interface LoadCache extends Omit<Map<string, Dict<LoadCacheData>>, 'get' | 'set' | 'has'> {
  /**
   * Retrieves a cached module job by its URL and optional module type.
   *
   * @param url The module URL.
   * @param type Optional module type discriminator.
   */
  get(url: string, type?: string): LoadCacheData | undefined

  /**
   * Stores a module job in the cache for the given URL and optional type.
   *
   * @param url The module URL.
   * @param type Optional module type discriminator.
   * @param job The module job to cache.
   */
  set(url: string, type?: string, job?: LoadCacheData): this

  /**
   * Checks whether a module job is cached for the given URL and optional type.
   *
   * @param url The module URL.
   * @param type Optional module type discriminator.
   */
  has(url: string, type?: string): boolean
}

/**
 * Wrapped ESM module instance providing access to its evaluated namespace.
 */
export interface ModuleWrap {
  /** The URL of the module. */
  url: string

  /**
   * Returns the evaluated export namespace object of the module.
   */
  getNamespace(): any
}

/**
 * Represents an in-flight or completed module evaluation job in the ESM loader.
 */
export interface ModuleJob {
  /** The resolved URL of the module. */
  url: string

  /** Reference to the module loader handling this job. */
  loader: ModuleLoader

  /** The wrapped module instance once instantiated/evaluated. */
  module?: ModuleWrap

  /** Import attributes associated with the module import statement. */
  importAttributes: ImportAttributes

  /** Promise resolving to the linked dependencies of this module. */
  linked: Promise<ModuleJob[]>

  /**
   * Instantiates the module and links its dependency graph.
   */
  instantiate(): Promise<void>

  /**
   * Executes the module code and returns the resulting module wrapper.
   */
  run(): Promise<{ module: ModuleWrap }>
}

/**
 * Interface describing the internal Node.js ESM module loader subsystem.
 *
 * Provides resolution, loading, caching, and custom hook registration for ES modules.
 */
export interface ModuleLoader {
  /** Cache storing loaded module jobs. */
  loadCache: LoadCache

  /**
   * Dynamically imports a module specifier relative to a parent URL.
   *
   * @param specifier The module name or path.
   * @param parentURL The URL of the importing module.
   * @param importAttributes Import attributes (e.g. `{ type: 'json' }`).
   */
  import(specifier: string, parentURL: string, importAttributes: ImportAttributes): Promise<any>

  /**
   * Registers a custom ESM loader hook.
   *
   * @param specifier The hook module specifier or URL.
   * @param parentURL Optional parent URL for resolving the specifier.
   * @param data Optional data passed to the hook.
   * @param transferList Optional list of transferable objects.
   */
  register(specifier: string | URL, parentURL?: string | URL, data?: any, transferList?: any[]): void

  /**
   * Asynchronously creates or retrieves a {@link ModuleJob} for the given specifier.
   *
   * @param specifier The module specifier.
   * @param parentURL The importing module URL.
   * @param importAttributes Import attributes.
   */
  getModuleJob(specifier: string, parentURL: string, importAttributes: ImportAttributes): Promise<ModuleJob>

  /**
   * Synchronously creates or retrieves a {@link ModuleJob} for the given specifier.
   *
   * @param specifier The module specifier.
   * @param parentURL The importing module URL.
   * @param importAttributes Import attributes.
   */
  getModuleJobSync(specifier: string, parentURL: string, importAttributes: ImportAttributes): ModuleJob

  /**
   * Asynchronously resolves a module specifier against a parent URL.
   *
   * @param originalSpecifier The module specifier to resolve.
   * @param parentURL The importing module URL.
   * @param importAttributes Import attributes.
   */
  resolve(originalSpecifier: string, parentURL: string, importAttributes: ImportAttributes): Promise<ResolveResult>

  /**
   * Synchronously resolves a module specifier against a parent URL.
   *
   * @param originalSpecifier The module specifier to resolve.
   * @param parentURL The importing module URL.
   * @param importAttributes Import attributes.
   */
  resolveSync(originalSpecifier: string, parentURL: string, importAttributes: ImportAttributes): ResolveResult

  /**
   * Asynchronously loads the source content for a resolved module specifier.
   *
   * @param specifier The resolved module URL.
   * @param context Context containing format and import attributes.
   */
  load(specifier: string, context: Pick<LoadHookContext, 'format' | 'importAttributes'>): Promise<LoadResult>

  /**
   * Synchronously loads the source content for a resolved module specifier.
   *
   * @param specifier The resolved module URL.
   * @param context Context containing format and import attributes.
   */
  loadSync(specifier: string, context: Pick<LoadHookContext, 'format' | 'importAttributes'>): LoadResult
}
