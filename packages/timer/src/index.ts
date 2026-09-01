import { Context, Service } from '@cordisjs/core'
import { remove } from 'cosmokit'

declare module '@cordisjs/core' {
  interface Context {
    /**
     * Timer service instance attached to this context.
     */
    timer: TimerService

    /**
     * Schedules a context-bound one-off callback execution after `delay` milliseconds.
     *
     * If the context scope is disposed before the timer fires, the timeout is automatically cleared.
     *
     * @param callback - The function to execute when the timer expires.
     * @param delay - The time to wait in milliseconds before executing the callback.
     * @returns A disposal function that can be invoked manually to cancel the timeout.
     */
    setTimeout(callback: () => void, delay: number): () => void

    /**
     * Schedules a context-bound recurring callback execution every `delay` milliseconds.
     *
     * If the context scope is disposed, the interval is automatically cleared.
     *
     * @param callback - The function to repeatedly execute.
     * @param delay - The interval period in milliseconds between executions.
     * @returns A disposal function that can be invoked manually to stop the interval.
     */
    setInterval(callback: () => void, delay: number): () => void

    /**
     * Asynchronously pauses execution for `delay` milliseconds.
     *
     * If the calling context is disposed before the delay has elapsed, the returned
     * promise is rejected with an Error (`Context has been disposed`).
     *
     * @param delay - The duration to sleep in milliseconds.
     * @returns A promise that resolves when the delay completes or rejects if the context is disposed.
     */
    sleep(delay: number): Promise<void>

    /**
     * Creates a throttled version of the provided callback that will only invoke the callback
     * at most once per `delay` milliseconds.
     *
     * Any pending trailing timer is automatically cancelled when the context scope is disposed,
     * or when calling `.dispose()` directly on the returned function.
     *
     * @param callback - The target function to throttle.
     * @param delay - The throttle window in milliseconds.
     * @param noTrailing - If `true`, disables trailing-edge execution when calls occur during cooldown.
     * @returns The throttled function with an attached `.dispose()` method for manual cleanup.
     */
    throttle<F extends (...args: any[]) => void>(callback: F, delay: number, noTrailing?: boolean): WithDispose<F>

    /**
     * Creates a debounced version of the provided callback that delays execution until
     * `delay` milliseconds have elapsed since the last time it was invoked.
     *
     * Any pending debounced execution is automatically cancelled when the context scope is disposed,
     * or when calling `.dispose()` directly on the returned function.
     *
     * @param callback - The target function to debounce.
     * @param delay - The debounce delay in milliseconds.
     * @returns The debounced function with an attached `.dispose()` method for manual cleanup.
     */
    debounce<F extends (...args: any[]) => void>(callback: F, delay: number): WithDispose<F>
  }
}

/**
 * Utility type wrapping a function with an additional `.dispose()` method for resource cleanup.
 */
type WithDispose<T> = T & { dispose: () => void }

/**
 * Context-aware Timer Service for Cordis.
 *
 * Provides lifecycle-managed timing utilities (`setTimeout`, `setInterval`, `sleep`, `throttle`, `debounce`)
 * that are automatically cleaned up when the invoking context or plugin is disposed, preventing timer leaks.
 */
export class TimerService extends Service {
  /**
   * Initializes the Timer service and mixes its timer utility methods onto the `Context` prototype.
   *
   * @param ctx - The Cordis context to bind this service to.
   */
  constructor(ctx: Context) {
    super(ctx, 'timer', true)
    ctx.mixin('timer', ['setTimeout', 'setInterval', 'sleep', 'throttle', 'debounce'])
  }

  /**
   * Schedules a one-off timer that is bound to the caller context lifecycle.
   *
   * Uses `ctx.effect()` to ensure that the timer is automatically cancelled via `clearTimeout`
   * if the surrounding context scope is disposed before the timer fires.
   *
   * @param callback - Function to execute when the timer expires.
   * @param delay - Delay in milliseconds.
   * @returns A disposal function that cancels the timer.
   */
  setTimeout(callback: () => void, delay: number) {
    const dispose = this.ctx.effect(() => {
      const timer = setTimeout(() => {
        dispose()
        callback()
      }, delay)
      return () => clearTimeout(timer)
    })
    return dispose
  }

  /**
   * Schedules a recurring interval timer bound to the caller context lifecycle.
   *
   * Uses `ctx.effect()` to ensure that the interval is automatically cancelled via `clearInterval`
   * if the surrounding context scope is disposed.
   *
   * @param callback - Function to execute at each interval.
   * @param delay - Interval delay in milliseconds.
   * @returns A disposal function that cancels the interval.
   */
  setInterval(callback: () => void, delay: number) {
    return this.ctx.effect(() => {
      const timer = setInterval(callback, delay)
      return () => clearInterval(timer)
    })
  }

  /**
   * Returns a promise that resolves after `delay` milliseconds.
   *
   * Rejects if the caller context is disposed before the timer completes.
   *
   * @param delay - Duration to pause in milliseconds.
   * @returns Promise that resolves on completion or rejects upon context disposal.
   */
  sleep(delay: number) {
    const caller = this.ctx
    return new Promise<void>((resolve, reject) => {
      const dispose1 = this.setTimeout(() => {
        dispose1()
        dispose2()
        resolve()
      }, delay)
      const dispose2 = caller.on('dispose', () => {
        dispose1()
        dispose2()
        reject(new Error('Context has been disposed'))
      })
    })
  }

  /**
   * Internal helper to create a lifecycle-managed function wrapper (used by throttle and debounce).
   *
   * Tracks pending timers and registers a disposal callback into `ctx.scope.disposables`
   * so timers are automatically cleared when the context scope terminates.
   *
   * @param callback - Wrapper generator invoked on each call, receiving args and an `isActive` predicate.
   * @param isDisposed - Initial disposal state flag.
   * @returns A callable wrapper function with a `.dispose()` method.
   */
  private createWrapper(callback: (args: any[], check: () => boolean) => any, isDisposed = false) {
    this.ctx.scope.assertActive()

    let timer: number | NodeJS.Timeout | undefined
    const dispose = () => {
      isDisposed = true
      remove(this.ctx.scope.disposables, dispose)
      clearTimeout(timer)
    }

    const wrapper: any = (...args: any[]) => {
      clearTimeout(timer)
      timer = callback(args, () => !isDisposed && this.ctx.scope.isActive)
    }
    wrapper.dispose = dispose
    this.ctx.scope.disposables.push(dispose)
    return wrapper
  }

  /**
   * Creates a throttled function that limits callback execution rate to at most once every `delay` ms.
   *
   * Supports immediate leading execution and optional trailing execution.
   *
   * @param callback - The target function to throttle.
   * @param delay - Minimum delay in milliseconds between executions.
   * @param noTrailing - If `true`, disables trailing execution for calls made within cooldown.
   * @returns The throttled function with `.dispose()` capability.
   */
  throttle<F extends (...args: any[]) => void>(callback: F, delay: number, noTrailing?: boolean): WithDispose<F> {
    let lastCall = -Infinity
    const execute = (...args: any[]) => {
      lastCall = Date.now()
      callback(...args)
    }
    return this.createWrapper((args, isActive) => {
      const now = Date.now()
      const remaining = delay - (now - lastCall)
      if (remaining <= 0) {
        execute(...args)
      } else if (isActive()) {
        return setTimeout(execute, remaining, ...args)
      }
    }, noTrailing)
  }

  /**
   * Creates a debounced function that postpones execution until `delay` ms have passed since the last invocation.
   *
   * @param callback - The target function to debounce.
   * @param delay - The delay in milliseconds of inactivity before executing.
   * @returns The debounced function with `.dispose()` capability.
   */
  debounce<F extends (...args: any[]) => void>(callback: F, delay: number): WithDispose<F> {
    return this.createWrapper((args, isActive) => {
      if (!isActive()) return
      return setTimeout(callback, delay, ...args)
    })
  }
}

export default TimerService

