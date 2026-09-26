import { setGlobalOptions } from 'firebase-functions/v2';

// `region` should match the Firestore database location to minimise trigger
// latency — verify in the Firebase console and adjust if the (default) database
// is not in asia-south1. Triggers still work cross-region, just slower.
setGlobalOptions({
  region: 'asia-south1',
  maxInstances: 10,
});

// Phase 5 — Community Moderation
export { onPostReported } from './moderation/onPostReported';

// Phase 6+ — Notifications
export * from './notifications';

// Phase 9 — Admin Triggers
export * from './admin';
