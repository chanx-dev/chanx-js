/** Thrown by `authenticate` to reject with a specific status. */
export class AuthenticationError extends Error {
  /** Sent as the `authentication` message's `status_code`. */
  readonly status: number;
  /** Sent as its `status_text`. */
  readonly statusText: string;
  /** Sent as its `data`. */
  readonly data: unknown;

  constructor({
    status = 403,
    statusText = 'Forbidden',
    data = { detail: 'You do not have permission to perform this action.' },
  }: { status?: number; statusText?: string; data?: unknown } = {}) {
    super(`Authentication failed: ${status} ${statusText}`);
    this.status = status;
    this.statusText = statusText;
    this.data = data;
  }
}
