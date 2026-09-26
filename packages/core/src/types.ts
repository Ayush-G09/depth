/** [price, quantity] as numbers. */
export type Level = [price: number, qty: number]

/** [price, quantity] exactly as the exchange sends them: decimal strings. */
export type RawLevel = [price: string, qty: string]

/** One incremental update from the depth stream. `U`..`u` is the range of update ids it covers. */
export interface DiffEvent {
  U: number
  u: number
  bids: RawLevel[]
  asks: RawLevel[]
}

/** A full picture of the book from the REST endpoint. */
export interface Snapshot {
  lastUpdateId: number
  bids: RawLevel[]
  asks: RawLevel[]
}

export type Side = 'bid' | 'ask'

export type SyncResult = 'buffered' | 'applied' | 'ignored' | 'resync' | 'live' | 'stale'

/**
 * What the server sends to browsers ~10 times a second. Quantities are summed into price buckets:
 * bucket `k0 + i` covers prices [(k0 + i) * bucket, (k0 + i + 1) * bucket). Index i of `bids` / `asks`
 * is the total resting quantity in that bucket (0 = nothing there).
 */
export interface BookFrame {
  type: 'book'
  symbol: string
  /** milliseconds since the epoch, when the frame was made */
  ts: number
  /** increases by one per frame; a gap means the client missed frames */
  seq: number
  /** 'live' when the book is in sync with the exchange; 'syncing' while it is being (re)built (arrays are empty then) */
  status: 'live' | 'syncing'
  mid: number | null
  spread: number | null
  /** bucket width, in quote currency */
  bucket: number
  /** index of the first bucket in the window */
  k0: number
  /** the price range the book is complete for (see SyncedBook.coverage); buckets outside it are unknown, not empty */
  cover: [lo: number, hi: number] | null
  bids: number[]
  asks: number[]
}
