import { Context } from 'cordis'
import { BuildFailure } from 'esbuild'
import { codeFrameColumns } from '@babel/code-frame'
import { readFileSync } from 'fs'

/**
 * Type guard to determine if a caught error is an esbuild {@link BuildFailure}.
 *
 * Checks whether the error object contains an array of `errors` where each entry has error text.
 *
 * @param e - The error object to inspect.
 * @returns `true` if the error matches the {@link BuildFailure} interface, `false` otherwise.
 */
function isBuildFailure(e: any): e is BuildFailure {
  return Array.isArray(e?.errors) && e.errors.every((error: any) => error.text)
}

/**
 * Handles and logs compilation/runtime errors encountered during Hot Module Replacement (HMR).
 *
 * When an esbuild {@link BuildFailure} occurs, this function extracts the source location
 * (file, line, and column) and renders a formatted code frame using `@babel/code-frame`
 * to provide visual syntax highlighting and context in the console logs.
 *
 * For non-build errors or cases where the source file cannot be read, it falls back
 * to standard warning logger output.
 *
 * @param ctx - The Cordis context providing the logger service.
 * @param e - The error or build failure to log.
 */
export function handleError(ctx: Context, e: any) {
  if (!isBuildFailure(e)) {
    ctx.logger.warn(e)
    return
  }

  for (const error of e.errors) {
    if (!error.location) {
      ctx.logger.warn(error.text)
      continue
    }
    try {
      const { file, line, column } = error.location
      const source = readFileSync(file, 'utf8')
      const formatted = codeFrameColumns(source, {
        start: { line, column },
      }, {
        highlightCode: true,
        message: error.text,
      })
      ctx.logger.warn(`File: ${file}:${line}:${column}\n` + formatted)
    } catch (e) {
      ctx.logger.warn(e)
    }
  }
}

