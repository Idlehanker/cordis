import { Dict } from 'cosmokit'
import { Context, ForkScope, Plugin } from '@cordisjs/core'
import { EntryOptions, Group, Loader, LoaderFile } from '../src'
import { Mock, mock } from 'node:test'
import { expect } from 'chai'

declare module '../src/index.ts' {
  interface Loader {
    /** Registers a mocked plugin function under the given name. */
    mock<F extends Function>(name: string, plugin: F): Mock<F>
    /** Asserts that a plugin is active with the expected configuration. */
    expectEnable(plugin: any, config?: any): void
    /** Asserts that a plugin is currently disabled/inactive. */
    expectDisable(plugin: any): void
    /** Asserts that a fork exists for the given entry ID and returns it. */
    expectFork(id: string): ForkScope
  }
}

/**
 * In-memory mock implementation of {@link LoaderFile} for unit tests.
 */
class MockLoaderFile extends LoaderFile {
  data: EntryOptions[] = []

  async read() {
    return this.data
  }

  write(data: EntryOptions[]) {
    this.data = data
  }
}

/**
 * Mock Loader class providing in-memory configuration, plugin mocking, and test assertions.
 */
export default class MockLoader extends Loader {
  declare file: MockLoaderFile

  /** Registry of in-memory mocked plugin modules. */
  public modules: Dict<Plugin.Object> = Object.create(null)

  /**
   * Creates a new MockLoader instance with an in-memory mock file and default group plugin registered.
   *
   * @param ctx The test context.
   */
  constructor(ctx: Context) {
    super(ctx, { name: 'cordis' })
    this.file = new MockLoaderFile('config-1.yml')
    this.file.ref(this)
    this.mock('cordis/group', Group)
  }

  async start() {
    await this.refresh()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  async import(name: string) {
    return this.modules[name]
  }

  /**
   * Registers a mock plugin function by name.
   *
   * @param name Module name.
   * @param plugin Implementation function.
   * @returns Mock function handle with call tracking.
   */
  mock<F extends Function>(name: string, plugin: F) {
    return this.modules[name] = mock.fn(plugin)
  }

  /**
   * Asserts that a plugin is registered and active in the context registry with matching configuration.
   *
   * @param plugin The plugin definition to check.
   * @param config Expected configuration object.
   */
  expectEnable(plugin: any, config?: any) {
    const runtime = this.ctx.registry.get(plugin)
    expect(runtime).to.be.ok
    expect(runtime!.config).to.deep.equal(config)
  }

  /**
   * Asserts that a plugin is not active in the context registry.
   *
   * @param plugin The plugin definition to check.
   */
  expectDisable(plugin: any) {
    const runtime = this.ctx.registry.get(plugin)
    expect(runtime).to.be.not.ok
  }

  /**
   * Asserts that an active fork exists for the specified entry ID and returns its fork scope.
   *
   * @param id The entry ID.
   * @returns The active {@link ForkScope}.
   */
  expectFork(id: string) {
    expect(this.store[id]?.fork).to.be.ok
    return this.store[id]!.fork!
  }
}

