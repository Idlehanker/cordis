import { defineProperty, remove } from 'cosmokit'
import { Context, Service } from '@cordisjs/core'
import Schema from 'schemastery'

export { default as Schema, default as z } from 'schemastery'

/**
 * Internal symbol attached to schema definitions to preserve sort order
 * when multiple schema extensions are merged into an intersection schema.
 */
const kSchemaOrder = Symbol('cordis.schema.order')

declare module '@cordisjs/core' {
  interface Events {
    /**
     * Emitted whenever a schema is added, updated, or removed from the {@link SchemaService}.
     */
    'internal/service-schema'(): void
  }
}

/**
 * Service for dynamically composable and reactive schema management in Cordis.
 *
 * Maintains an intersection schema (`Schema.intersect([])`) that can be extended
 * by different plugins or services. When extended within a context scope, the schema
 * addition is automatically tracked as a context effect and removed upon disposal.
 */
export class SchemaService {
  /**
   * The underlying composite intersection schema containing all active schema extensions.
   */
  _data = Schema.intersect([]) as Schema & { list: Schema[] }

  /**
   * Creates a new SchemaService instance bound to a Cordis context.
   *
   * @param ctx - The Cordis context associated with this schema service.
   */
  constructor(public ctx: Context) {
    defineProperty(this, Service.tracker, {
      property: 'ctx',
    })
  }

  /**
   * Extends the composite schema with an additional schema fragment.
   *
   * The schema is inserted into the intersection list in descending order based on `order`.
   * Higher order schemas appear first.
   *
   * This method uses `ctx.effect()`, meaning that if the calling context is disposed,
   * the added schema will automatically be removed from the intersection list and
   * the `'internal/service-schema'` event will be re-emitted.
   *
   * @param schema - The schema definition to merge into the composite schema.
   * @param order - Priority weight determining position in the intersection list (defaults to 0).
   * @returns A disposal function / ForkScope handle to remove the schema extension.
   */
  extend(schema: Schema, order = 0) {
    const index = this._data.list.findIndex(a => a[kSchemaOrder] < order)
    schema[kSchemaOrder] = order
    return this.ctx.effect(() => {
      if (index >= 0) {
        this._data.list.splice(index, 0, schema)
      } else {
        this._data.list.push(schema)
      }
      this.ctx.emit('internal/service-schema')
      return () => {
        remove(this._data.list, schema)
        this.ctx.emit('internal/service-schema')
      }
    })
  }

  /**
   * Serializes the composite schema to a JSON representation.
   *
   * Useful for schema introspection, UI form generation, and API responses.
   *
   * @returns JSON-serializable representation of the composite schema.
   */
  toJSON() {
    return this._data.toJSON()
  }
}

export default SchemaService

