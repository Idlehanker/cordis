import { access, constants, readFile, rename, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { remove } from 'cosmokit'
import * as yaml from 'js-yaml'
import { EntryOptions } from './entry.ts'
import { ImportTree } from './import.ts'
import { JsExpr } from './utils.ts'

/**
 * Extended YAML schema including the custom `!js` JavaScript expression type.
 */
export const schema = yaml.JSON_SCHEMA.extend(JsExpr)

/**
 * Abstraction representing a physical configuration file on the filesystem.
 *
 * Handles:
 * - Asynchronous file parsing for YAML, JSON, and dynamic module formats.
 * - Debounced and atomic file writing (via `.tmp` file and atomic rename).
 * - File access permissions detection.
 * - Reference counting for trees sharing the same configuration file.
 */
export class LoaderFile {
  /** Flag to suppress reloading during self-writes. */
  public suspend = false

  /** Indicates whether the file is read-only. */
  public readonly: boolean

  /** List of {@link ImportTree} instances referencing this file. */
  public trees: ImportTree[] = []

  /** Debounce timer handle for pending write operations. */
  public writeTask?: NodeJS.Timeout

  /**
   * Creates a new LoaderFile instance.
   *
   * @param name Absolute path to the configuration file.
   * @param type MIME type string (e.g. `'application/yaml'`, `'application/json'`), or undefined for dynamic modules.
   */
  constructor(public name: string, public type?: string) {
    this.readonly = !type
  }

  /**
   * Registers an {@link ImportTree} as referencing this file.
   *
   * @param tree The importing tree instance.
   */
  ref(tree: ImportTree) {
    this.trees.push(tree)
    tree.url = pathToFileURL(this.name).href
    tree.ctx.loader.files[tree.url] ??= this
  }

  /**
   * Unregisters an {@link ImportTree} from this file, removing the file mapping when no references remain.
   *
   * @param tree The importing tree instance.
   */
  unref(tree: ImportTree) {
    remove(this.trees, tree)
    if (this.trees.length) return
    delete tree.ctx.loader.files[tree.url]
  }

  /**
   * Verifies write permissions on the file, marking it read-only if writes are not permitted.
   */
  async checkAccess() {
    if (!this.type) return
    try {
      await access(this.name, constants.W_OK)
    } catch {
      this.readonly = true
    }
  }

  /**
   * Reads and parses configuration entries from the file based on its MIME type.
   *
   * @returns Promise resolving to an array of parsed {@link EntryOptions}.
   */
  async read(): Promise<EntryOptions[]> {
    if (this.type === 'application/yaml') {
      return yaml.load(await readFile(this.name, 'utf8'), { schema }) as any
    } else if (this.type === 'application/json') {
      // Direct JSON.parse used instead of require/import to avoid module cache pollution
      return JSON.parse(await readFile(this.name, 'utf8')) as any
    } else {
      const module = await import(this.name)
      return module.default || module
    }
  }

  /**
   * Atomically writes configuration data to disk using a temporary file.
   *
   * @param config The array of entry options to serialize.
   * @throws If the file is read-only.
   */
  private async _write(config: EntryOptions[]) {
    this.suspend = true
    if (this.readonly) {
      throw new Error(`cannot overwrite readonly config`)
    }
    if (this.type === 'application/yaml') {
      await writeFile(this.name + '.tmp', yaml.dump(config, { schema }))
    } else if (this.type === 'application/json') {
      await writeFile(this.name + '.tmp', JSON.stringify(config, null, 2))
    }
    await rename(this.name + '.tmp', this.name)
  }

  /**
   * Schedules a debounced atomic write operation on the next event loop turn.
   *
   * @param config The array of entry options to write.
   */
  write(config: EntryOptions[]) {
    clearTimeout(this.writeTask)
    this.writeTask = setTimeout(() => {
      this.writeTask = undefined
      this._write(config)
    }, 0)
  }
}

export namespace LoaderFile {
  /**
   * Map of writable file extensions to their corresponding MIME types.
   */
  export const writable = {
    '.json': 'application/json',
    '.yaml': 'application/yaml',
    '.yml': 'application/yaml',
  }

  /**
   * Set of all supported configuration file extensions.
   */
  export const supported = new Set(Object.keys(writable))

  if (typeof require !== 'undefined') {
    // eslint-disable-next-line n/no-deprecated-api
    for (const extname in require.extensions) {
      supported.add(extname)
    }
  }
}
