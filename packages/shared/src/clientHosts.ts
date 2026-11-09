/**
 * The client's own accounts (docs/CLIENT_ACCOUNTS.md). Team IDs live here, never inline at a call site. Shared so the
 * API (season leaderboard highlights) and the web (admin editor defaults) read the same ids.
 */
export const CLIENT_HOSTS = {
  /** Dor Dabush — "Dorsenal". */
  dor: { fplEntryId: '11597' },
  /** Itay Tebeka — "ShawMustGoOn!". */
  itay: { fplEntryId: '17754' },
} as const;
