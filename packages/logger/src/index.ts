import { Context, Service } from '@cordisjs/core'
import { defineProperty } from 'cosmokit'
import Logger from 'reggol'

export { Logger }

declare module '@cordisjs/core' {
  interface Context {
    /**
     * Logger service instance attached to the current context.
     *
     * Can be invoked directly as a factory function to create or retrieve a named logger:
     * ```ts
     * const customLogger = ctx.logger('my-plugin')
     * customLogger.info('Hello world!')
     * ```
     *
     * Or used directly with shortcut logging methods (which automatically uses `ctx.name` as the logger name):
     * ```ts
     * ctx.logger.info('Plugin initialized')
     * ctx.logger.warn('Configuration warning')
     * ```
     */
    logger: LoggerService
  }
}

declare module 'reggol' {
  namespace Logger {
    interface Meta {
      /**
       * The Cordis context associated with this logger instance.
       */
      ctx?: Context
    }
  }
}

/**
 * Callable logger service interface.
 *
 * Provides factory invocation to create named {@link Logger} instances,
 * as well as direct shortcut methods for logging levels (`info`, `warn`, `error`, `debug`, `success`)
 * and extending logger definitions.
 */
export interface LoggerService extends Pick<Logger, Logger.Type | 'extend'> {
  /**
   * Creates or retrieves a {@link Logger} instance bound to the specified name and caller context.
   *
   * @param name - The identifier or namespace for the logger.
   * @returns A new {@link Logger} instance configured with context metadata.
   */
  (name: string): Logger
}

/**
 * Core logging service for Cordis applications.
 *
 * Integrates the `reggol` logging library into Cordis contexts. Provides:
 * - Immediate availability on context creation (`immediate: true`).
 * - Forwarding of internal framework log events (`internal/info`, `internal/error`, `internal/warning`) to `'app'` logger.
 * - Callable service pattern allowing `ctx.logger('name')` or direct `ctx.logger.info(...)`.
 * - Automatic naming based on context/plugin name (`ctx.name`).
 */
export class LoggerService extends Service {
  /**
   * Initializes the logger service on the given context.
   *
   * Registers event handlers for internal Cordis core events to output diagnostic logs
   * under the `'app'` logger namespace.
   *
   * @param ctx - The Cordis context to bind this service to.
   */
  constructor(ctx: Context) {
    super(ctx, 'logger', true)

    // Forward internal info messages to the 'app' logger
    ctx.on('internal/info', function (format, ...args) {
      this.logger('app').info(format, ...args)
    })

    // Forward internal error messages to the 'app' logger
    ctx.on('internal/error', function (format, ...args) {
      this.logger('app').error(format, ...args)
    })

    // Forward internal warning messages to the 'app' logger
    ctx.on('internal/warning', function (format, ...args) {
      this.logger('app').warn(format, ...args)
    })
  }

  /**
   * Invocation handler called when `ctx.logger(name)` is executed as a function.
   *
   * Creates a new `Logger` instance with the given name and attaches the caller's
   * `Context` instance to the logger's metadata for downstream filtering/formatting.
   *
   * @param name - The name/namespace for the logger.
   * @returns A new {@link Logger} instance.
   */
  [Service.invoke](name: string) {
    return new Logger(name, defineProperty({}, 'ctx', this.ctx))
  }

  /**
   * Dynamically defines shortcut logging methods on the `LoggerService` prototype.
   *
   * For each logging method ('success', 'error', 'info', 'warn', 'debug', 'extend'),
   * calling `ctx.logger[type](...args)` delegates to `ctx.logger(ctx.name)[type](...args)`.
   */
  static {
    for (const type of ['success', 'error', 'info', 'warn', 'debug', 'extend']) {
      LoggerService.prototype[type] = function (this: LoggerService, ...args: any[]) {
        return this(this.ctx.name)[type](...args)
      }
    }
  }
}

export default LoggerService

