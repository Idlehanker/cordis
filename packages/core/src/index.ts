/**
 * @cordisjs/core
 *
 * A lightweight, progressive, and extensible plugin framework for TypeScript / JavaScript.
 *
 * Core exports:
 * - `Context`: The central inversion-of-control container and execution context.
 * - `Lifecycle` / `Events`: Event dispatcher supporting parallel, serial, bail, and scoped event listeners.
 * - `Registry` / `Plugin` / `Inject`: Plugin loading, dependency injection, and lifecycle management.
 * - `EffectScope` / `ForkScope` / `MainScope`: Hierarchical scope management, effect disposal, and hot reloading.
 * - `Service`: Base class for context-bound, injectable services.
 * - `utils`: Helper functions, symbols, and reflection utilities.
 */

export * from './context.ts'
export * from './events.ts'
export * from './registry.ts'
export * from './scope.ts'
export * from './service.ts'
export * from './utils.ts'

