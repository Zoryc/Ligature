/** Size and count limits. All byte values. */
export const MB = 1024 * 1024

export const MAX_BLOB_BYTES = 100 * MB
export const MAX_JSON_BYTES = 10 * MB
export const MAX_MANIFEST_ENTRIES = 20_000

export const MAX_PDF_BYTES = 100 * MB
export const MAX_SYNCTEX_BYTES = 100 * MB
export const MAX_LOG_BYTES = 2 * MB
/** latexmk stdout/stderr kept as a fallback log when out/output.log is missing. */
export const MAX_CONSOLE_BYTES = 256 * 1024

export const DEFAULT_TIMEOUT_MS = 90_000
export const MIN_TIMEOUT_MS = 1_000
export const DEFAULT_MAX_TIMEOUT_MS = 300_000
/** Extra time the worker gives the helper (setup + streaming outputs) on top of the latexmk timeout. */
export const HELPER_GRACE_MS = 60_000

/** Framing: a DATA frame carries at most this much. */
export const DATA_CHUNK_BYTES = MB
/** Framing: a CONTROL (JSON) frame carries at most this much (a 10 MB manifest, or a 2 MB log with escapes). */
export const MAX_CONTROL_BYTES = 32 * MB
/** Hard cap on the log the helper reports (capped log text plus a few notice lines), in UTF-8 bytes. */
export const MAX_REPORTED_LOG_BYTES = MAX_LOG_BYTES + 64 * 1024
