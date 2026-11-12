export type OrcoErrorCode = 'invalid' | 'not_found' | 'forbidden' | 'conflict' | 'rate_limited' | 'unavailable';

export class OrcoError extends Error {
  constructor(
    readonly code: OrcoErrorCode,
    message: string,
  ) {
    super(message);
  }
}
