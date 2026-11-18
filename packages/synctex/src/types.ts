/** Record kinds, as stored in `SynctexIndex.kind`. */
export const Kind = {
  /** `[` … `]` */
  VBox: 1,
  /** `(` … `)` */
  HBox: 2,
  /** `v` void vbox */
  VoidVBox: 3,
  /** `h` void hbox */
  VoidHBox: 4,
  /** `k` kern (has a width) */
  Kern: 5,
  /** `g` glue */
  Glue: 6,
  /** `$` math on/off */
  Math: 7,
  /** `x` current position (word boundaries) */
  Boundary: 8,
  /** `r` rule (has W, H, D) */
  Rule: 9,
} as const
export type Kind = (typeof Kind)[keyof typeof Kind]

/** Size limits for `parseSynctex`. */
export interface SynctexLimits {
  /** Reject longer texts with `SynctexError('TooLarge')`. Counted in UTF-16 code units (≈ bytes: the
   *  format is ASCII except for input paths). Default 50 MiB. */
  maxChars?: number
  /** Stop parsing (and set `truncated`) after this many records. Default 2,000,000. */
  maxRecords?: number
}

export const DEFAULT_MAX_CHARS = 50 * 1024 * 1024
export const DEFAULT_MAX_RECORDS = 2_000_000

/**
 * A parsed SyncTeX file. Records are stored column-wise (one typed array per field, indexed by record
 * number) in document order, so a record's parent always has a smaller index than the record itself.
 * Dimensions are raw SyncTeX units; `toPdf*` helpers convert them with `scale` and the offsets.
 */
export interface SynctexIndex {
  /** Input tag -> path as written by TeX, normalised (`/` separators, no `.` segments). */
  readonly inputs: ReadonlyMap<number, string>
  /** Number of records. */
  readonly count: number
  /** Highest page number seen. */
  readonly pageCount: number
  /** True when parsing stopped at `maxRecords`. */
  readonly truncated: boolean
  /** PDF points per raw unit (Unit and Magnification applied). */
  readonly scale: number
  /** Offsets in PDF points, added after scaling. */
  readonly xOffset: number
  readonly yOffset: number
  readonly kind: Uint8Array
  readonly tag: Int32Array
  readonly line: Int32Array
  /** -1 when TeX did not record a column (the usual case). */
  readonly column: Int32Array
  /** 1-based page; 0 for records outside any page (forms, damaged input). */
  readonly page: Int32Array
  /** Index of the enclosing box record, or -1. */
  readonly parent: Int32Array
  /** Nesting depth (0 = directly on the page). */
  readonly depth: Int32Array
  /** Reference point (left edge, baseline). */
  readonly h: Int32Array
  readonly v: Int32Array
  /** Width, height above and depth below the baseline (0 for point records; kerns have a width). */
  readonly width: Int32Array
  readonly height: Int32Array
  readonly depthBelow: Int32Array
}

export const isBox = (k: number): boolean => k === Kind.VBox || k === Kind.HBox
export const isVoid = (k: number): boolean => k === Kind.VoidVBox || k === Kind.VoidHBox || k === Kind.Rule
