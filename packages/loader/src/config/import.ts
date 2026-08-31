import { Context } from '@cordisjs/core'
import { dirname, extname, resolve } from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { EntryTree } from './tree.ts'
import { LoaderFile } from './file.ts'
import Loader from '../loader.ts'

/**
 * An {@link EntryTree} backed by a physical configuration file on disk.
 *
 * Handles:
 * - Locating or creating configuration files based on supported extensions.
 * - Initializing base directory context services (`ctx.baseDir`).
 * - Reloading tree state when the configuration file changes.
 * - Emitting `loader/config-update` and debouncing disk writes.
 *
 * @template C The Context subtype.
 */
export class ImportTree<C extends Context = Context> extends EntryTree<C> {
  /** Marks the tree plugin as reusable across contexts. */
  static reusable = true

  /** The backing configuration file instance. */
  public file!: LoaderFile

  /**
   * Creates an ImportTree instance and binds lifecycle listeners (`ready`, `dispose`).
   *
   * @param ctx The context instance.
   */
  constructor(public ctx: C) {
    super(ctx)
    ctx.on('ready', () => this.start())
    ctx.on('dispose', () => this.stop())
  }

  /**
   * Starts the import tree by refreshing entries from file and checking write permissions.
   */
  async start() {
    await this.refresh()
    await this.file.checkAccess()
  }

  /**
   * Reads the configuration file and updates the root group entries.
   */
  async refresh() {
    this.root.update(await this.file.read())
  }

  /**
   * Stops the root entry group and unregisters this tree from the backing file.
   */
  stop() {
    this.file?.unref(this)
    return this.root.stop()
  }

  /**
   * Emits `loader/config-update` and schedules writing the root group configuration to disk.
   */
  write() {
    this.context.emit('loader/config-update')
    return this.file.write(this.root.data)
  }

  /**
   * Initializes the configuration file and sets up `ctx.baseDir`.
   *
   * @param baseDir The root working directory.
   * @param options Loader configuration options.
   */
  async init(baseDir: string, options: Loader.Config) {
    if (options.filename) {
      const filename = resolve(baseDir, options.filename)
      const stats = await stat(filename)
      if (stats.isFile()) {
        baseDir = dirname(filename)
        const ext = extname(filename)
        const type = LoaderFile.writable[ext]
        if (!LoaderFile.supported.has(ext)) {
          throw new Error(`extension "${ext}" not supported`)
        }
        this.file = new LoaderFile(filename, type)
        this.file.ref(this)
      } else {
        baseDir = filename
        await this._init(baseDir, options)
      }
    } else {
      await this._init(baseDir, options)
    }
    this.ctx.provide('baseDir', baseDir, true)
  }

  /**
   * Scans `baseDir` for existing configuration files matching `options.name + extension`.
   * If none is found and `initial` template is provided, creates a default `.yml` file.
   *
   * @param baseDir The directory to search.
   * @param options Loader configuration options.
   */
  private async _init(baseDir: string, options: Loader.Config) {
    const { name, initial } = options
    const dirents = await readdir(baseDir, { withFileTypes: true })
    for (const extension of LoaderFile.supported) {
      const dirent = dirents.find(dirent => dirent.name === name + extension)
      if (!dirent) continue
      if (!dirent.isFile()) {
        throw new Error(`config file "${dirent.name}" is not a file`)
      }
      const type = LoaderFile.writable[extension]
      const filename = resolve(baseDir, name + extension)
      this.file = new LoaderFile(filename, type)
      this.file.ref(this)
      return
    }
    if (initial) {
      const type = LoaderFile.writable['.yml']
      const filename = resolve(baseDir, name + '.yml')
      this.file = new LoaderFile(filename, type)
      this.file.ref(this)
      return this.file.write(initial as any)
    }
    throw new Error('config file not found')
  }
}

export namespace Import {
  /**
   * Configuration options for the {@link Import} plugin.
   */
  export interface Config {
    /** File path or relative URL to the imported configuration file. */
    url: string
  }
}

/**
 * Plugin allowing external configuration files to be imported and mounted as subtrees.
 */
export class Import extends ImportTree {
  /**
   * Creates an Import plugin instance.
   *
   * @param ctx The scoped context.
   * @param config The import configuration containing the file URL.
   */
  constructor(ctx: Context, public config: Import.Config) {
    super(ctx)
  }

  /**
   * Resolves the target file URL relative to the parent tree, binds the file, and starts the subtree.
   */
  async start() {
    const { url } = this.config
    const filename = fileURLToPath(new URL(url, this.ctx.scope.entry!.parent.tree.url))
    const ext = extname(filename)
    if (!LoaderFile.supported.has(ext)) {
      throw new Error(`extension "${ext}" not supported`)
    }
    this.file = new LoaderFile(filename, LoaderFile.writable[ext])
    this.file.ref(this)
    await super.start()
  }
}
