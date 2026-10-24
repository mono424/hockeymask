/**
 * The contract every source connector fulfils: list tables, read column names and types,
 * sample rows, plus a full `read` and a native `query`. Concrete connectors live with the
 * host that reaches its systems (the demo's NetSuite and Snowflake clients are in apps/api);
 * the mapping engine only ever sees rows.
 *
 * Connectors decode the wire format (numbers sent as strings, dates as epoch days or in the
 * account's date format) but never interpret values: a NetSuite checkbox still arrives as
 * 'T' / 'F', a placeholder date still arrives as '9999-01-01'. Interpretation is the mapping's job.
 */

import type { Row, RowSet, Table, TableRef } from './schema'

export interface Connector {
  /** Name of the source system, e.g. "NetSuite"; becomes `source_system` on imported rows. */
  readonly system: string
  /** Language `query` accepts, e.g. "suiteql" or "snowflake". */
  readonly dialect: string
  listTables(): Promise<TableRef[]>
  describe(table: string): Promise<Table>
  sample(table: string, limit?: number): Promise<RowSet>
  read(table: string, options?: { batchSize?: number }): AsyncIterable<Row[]>
  query(sql: string, options?: { limit?: number }): Promise<RowSet>
}

/** The source rejected a request; the message is safe to show to the user. */
export class ConnectorError extends Error {
  override name = 'ConnectorError'
}

/** The source could not be reached at all (network, DNS, timeout). */
export class SourceUnavailable extends ConnectorError {
  override name = 'SourceUnavailable'
}
