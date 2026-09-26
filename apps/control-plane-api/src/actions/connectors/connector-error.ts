/** A connector failure. Codes and status only: provider bodies can echo credentials or data. */
export class ConnectorError extends Error {
  constructor(
    readonly code: 'CONNECTOR_REQUEST_FAILED' | 'CONNECTOR_RESPONSE_INVALID',
    readonly status?: number,
  ) {
    super(code);
  }
}
