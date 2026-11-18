/** Why a SyncTeX file was rejected. */
export type SynctexErrorCode =
  /** The (gunzipped) text is larger than `limits.maxChars`. */
  | 'TooLarge'
  /** The text is not a SyncTeX file (no `SyncTeX Version:` header). */
  | 'Invalid'

/** The only error type `parseSynctex` throws. Damaged records are skipped, not reported. */
export class SynctexError extends Error {
  readonly code: SynctexErrorCode

  constructor(code: SynctexErrorCode, message: string) {
    super(message)
    this.name = 'SynctexError'
    this.code = code
  }
}
