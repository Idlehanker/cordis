import { Context, EffectScope, Inject } from '@cordisjs/core'
import { filterKeys } from 'cosmokit'
import { Entry } from './entry.ts'

declare module './entry.ts' {
  interface EntryOptions {
    /**
     * Declared service dependencies for the entry.
     *
     * If required services are unavailable on context, the entry will be prevented from starting
     * until the required services are provided.
     */
    inject?: Inject | null
  }
}

/** Plugin name identifier. */
export const name = 'inject'

/**
 * Installs service dependency checking and reactive lifecycle listeners on the context.
 *
 * Responsibilities:
 * - Augments entry readiness check (`loader/entry-check`) with required service validation.
 * - Answers `internal/inject` queries by inspecting the scope hierarchy.
 * - Reacts to global service availability changes (`internal/before-service`, `internal/service`)
 *   by triggering `entry.refresh()` on affected entries.
 *
 * @param ctx The root context instance.
 */
export function apply(ctx: Context) {
  /**
   * Resolves and filters the required service dependencies for an entry.
   *
   * @param entry The target entry.
   * @returns Dictionary of required service descriptors.
   */
  function getRequired(entry: Entry) {
    return filterKeys(Inject.resolve(entry.options.inject), (_, meta) => meta.required)
  }

  /**
   * Recursively checks if a service is declared in the injection list of a scope,
   * its runtime children, or its ancestor scopes.
   *
   * @param scope The effect scope to inspect.
   * @param name The service name.
   * @returns `true` if declared in injection requirements, `false` otherwise.
   */
  const checkInject = (scope: EffectScope, name: string) => {
    if (!scope.runtime.plugin) return false
    if (scope.runtime === scope) {
      return scope.runtime.children.every(fork => checkInject(fork, name))
    }
    if (name in Inject.resolve(scope.entry?.options.inject)) return true
    return checkInject(scope.parent.scope, name)
  }

  // Answer internal dependency injection checks
  ctx.on('internal/inject', function (this, name) {
    return checkInject(this.scope, name)
  })

  // Prevent entry from starting if any required service is missing from context
  ctx.on('loader/entry-check', (entry) => {
    for (const name in getRequired(entry)) {
      if (!entry.ctx.get(name)) return true
    }
  })

  // Refresh dependent entries before a service is modified or unloaded
  ctx.on('internal/before-service', (name) => {
    for (const entry of ctx.loader.entries()) {
      if (!(name in getRequired(entry))) continue
      entry.refresh()
    }
  }, { global: true })

  // Refresh dependent entries after a service is registered or loaded
  ctx.on('internal/service', (name) => {
    for (const entry of ctx.loader.entries()) {
      if (!(name in getRequired(entry))) continue
      entry.refresh()
    }
  }, { global: true })
}
