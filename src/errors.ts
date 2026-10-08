/** A non-2xx API response, or a body that did not match the documented V1 contract (`contract_mismatch`). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** A server-built transaction the SDK refused to sign. Nothing was sent. */
export class UnsafeTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeTransactionError";
  }
}
