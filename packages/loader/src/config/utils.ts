import { valueMap } from 'cosmokit'
import * as yaml from 'js-yaml'

/**
 * Dynamically evaluates a JavaScript expression within the scope of a context object using `with (ctx)`.
 *
 * @param ctx The context object providing scope variables.
 * @param expr The JavaScript expression string to evaluate.
 * @returns The evaluation result.
 */
// eslint-disable-next-line no-new-func
export const evaluate = new Function('ctx', 'expr', `
  with (ctx) {
    return eval(expr)
  }
`) as ((ctx: object, expr: string) => any)

/**
 * Recursively interpolates configuration values, evaluating embedded {@link JsExpr} JavaScript expressions.
 *
 * Traverses primitives, arrays, and plain objects.
 *
 * @param ctx The context object used for expression evaluation.
 * @param value The value, object, array, or expression to interpolate.
 * @returns The resolved data structure with expressions evaluated.
 */
export function interpolate(ctx: object, value: any) {
  if (isJsExpr(value)) {
    return evaluate(ctx, value.__jsExpr)
  } else if (!value || typeof value !== 'object') {
    return value
  } else if (Array.isArray(value)) {
    return value.map(item => interpolate(ctx, item))
  } else {
    return valueMap(value, item => interpolate(ctx, item))
  }
}

/**
 * Type guard checking whether a value is a {@link JsExpr} wrapper object.
 *
 * @param value The value to check.
 */
function isJsExpr(value: any): value is JsExpr {
  return value instanceof Object && '__jsExpr' in value
}

/**
 * Represents a raw JavaScript expression parsed from YAML configuration.
 */
export interface JsExpr {
  /** The raw JavaScript expression string. */
  __jsExpr: string
}

/**
 * YAML custom scalar type definition for `!js` expressions (`tag:yaml.org,2002:js`).
 *
 * Allows embedding executable JavaScript expressions in YAML configuration files.
 */
export const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
  predicate: isJsExpr,
  represent: (data) => data['__jsExpr'],
})
