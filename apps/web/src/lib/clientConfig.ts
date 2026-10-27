/**
 * The client's own accounts (docs/CLIENT_ACCOUNTS.md). Ids live here, never inline at a call site.
 */
export const CLIENT_HOSTS = {
  /** Dor Dabush — "Dorsenal". */
  dor: { fplEntryId: '11597' },
  /** Itay Tebeka — "ShawMustGoOn!". */
  itay: { fplEntryId: '17754' },
} as const;

/** Contact for community questions, ban appeals and deletion requests (shown on /terms/). */
export const CONTACT_EMAIL = 'ashalim.fantasy@gmail.com';
