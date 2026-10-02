/**
 * A connector failure. Codes and status only: provider bodies can echo credentials or data.
 *
 * `CONNECTOR_OUTCOME_UNKNOWN` is for a write the provider did not confirm: the request may have
 * been applied (no response, a server error, or an accepted request whose answer could not be
 * read). It is never retried; a person reconciles it (ADR 0036).
 */
export class ConnectorError extends Error {
  constructor(
    readonly code:
      'CONNECTOR_REQUEST_FAILED' | 'CONNECTOR_RESPONSE_INVALID' | 'CONNECTOR_OUTCOME_UNKNOWN',
    readonly status?: number,
  ) {
    super(code);
  }
}

/** The failure for a write's HTTP status: the provider refused it, or may have applied it. */
export function writeFailure(status: number): ConnectorError {
  return new ConnectorError(
    status >= 500 ? 'CONNECTOR_OUTCOME_UNKNOWN' : 'CONNECTOR_REQUEST_FAILED',
    status,
  );
}
