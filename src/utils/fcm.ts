import type { DocumentReference } from 'firebase-admin/firestore';

import { db, FieldValue } from './firebase';

/** FCM error codes indicating a registration token is dead and should be removed. */
const DEAD_TOKEN_CODES = new Set<string>([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
]);

interface FirebaseErrorWithCode {
  code?: string;
}

/** Extracts an error code from an unknown caught error, if present. */
export function getErrorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as FirebaseErrorWithCode).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** Returns true if the error means the FCM registration token is dead. */
export function isDeadTokenError(err: unknown): boolean {
  const code = getErrorCode(err);
  return code !== undefined && DEAD_TOKEN_CODES.has(code);
}

/**
 * Deletes `fcmToken` from a user document, but only if it still holds the
 * token that failed. Guards against wiping a fresh token the client saved
 * between our read and the failed send.
 *
 * @returns true if the token was removed.
 */
export async function removeDeadToken(
  userRef: DocumentReference,
  deadToken: string,
): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists || snap.get('fcmToken') !== deadToken) {
      return false;
    }
    tx.update(userRef, { fcmToken: FieldValue.delete() });
    return true;
  });
}
