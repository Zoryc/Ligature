/**
 * An error with an HTTP status and a contract error code (docs/M1.md §1).
 * Services throw it; the HTTP layer turns it into `{ error, message? }`.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 408 | 409 | 411 | 413 | 429 | 500 | 503,
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code)
    this.hasMessage = message !== undefined
  }
  readonly hasMessage: boolean
}

export const notFound = (message?: string) => new ApiError(404, 'not-found', message)
export const forbidden = (message?: string) => new ApiError(403, 'forbidden', message)
export const badRequest = (message?: string) => new ApiError(400, 'bad-request', message)
