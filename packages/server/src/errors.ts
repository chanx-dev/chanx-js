/** Thrown by `authenticate` to reject with a specific status, as DRF's responses do. */
export class AuthenticationError extends Error {
  readonly status: number;
  readonly statusText: string;
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
