/**
 * Integration seam between screens and their data.
 * - `preview`: isolated, synthetic in-memory fixtures. No network, no persistence.
 * - `api`: reserved for a future contract-backed client; none exists yet.
 * Screens depend only on this interface, so a preview source can later be
 * replaced by an API source without rewriting the screen.
 */
export type DataSourceKind = 'preview' | 'api';

export interface ReadSource<TQuery, TResult> {
  readonly kind: DataSourceKind;
  load(query: TQuery, signal: AbortSignal): Promise<TResult>;
}
