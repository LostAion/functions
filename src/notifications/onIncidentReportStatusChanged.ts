import { logger } from 'firebase-functions';
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';

import type { IncidentReport } from '../types';
import { db, FieldValue, messaging } from '../utils/firebase';

/** FCM error codes indicating a registration token is dead and should be removed. */
const DEAD_TOKEN_CODES = new Set<string>([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
]);

interface FirebaseErrorWithCode {
  code?: string;
}

/** Extracts an error code from an unknown caught error, if present. */
function getErrorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as FirebaseErrorWithCode).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

interface UserProfile {
  fcmToken?: string;
}

/**
 * Fires when an `incidentReports/{reportId}` document is updated.
 *
 * When the incident status changes (`before.status !== after.status`), fetches
 * the victim user from `users/{userId}` and dispatches a push notification if
 * the user has an FCM registration token.
 *
 * Cleans up invalid or unregistered FCM tokens in Firestore if messaging fails.
 * Idempotent: No-op if status did not change.
 */
export const onIncidentReportStatusChanged = onDocumentUpdated(
  'incidentReports/{reportId}',
  async (event): Promise<void> => {
    const reportId = event.params.reportId;

    if (!event.data) {
      logger.warn('onIncidentReportStatusChanged: update event carried no data', { reportId });
      return;
    }

    const before = event.data.before.data() as IncidentReport | undefined;
    const after = event.data.after.data() as IncidentReport | undefined;

    if (!before || !after) {
      return;
    }

    // Idempotency: only notify when the status actually transitions
    if (before.status === after.status) {
      return;
    }

    if (!after.userId || typeof after.userId !== 'string') {
      logger.warn('onIncidentReportStatusChanged: report has no valid userId', {
        reportId,
        userId: after.userId,
      });
      return;
    }

    const userRef = db.collection('users').doc(after.userId);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      logger.info('onIncidentReportStatusChanged: victim user document not found', {
        reportId,
        userId: after.userId,
      });
      return;
    }

    const userData = userSnap.data() as UserProfile | undefined;
    const fcmToken = userData?.fcmToken;

    if (!fcmToken || typeof fcmToken !== 'string' || fcmToken.trim().length === 0) {
      logger.info('onIncidentReportStatusChanged: user has no fcmToken', {
        reportId,
        userId: after.userId,
      });
      return;
    }

    logger.info('Notifying victim of incident report status update', {
      reportId,
      userId: after.userId,
      oldStatus: before.status,
      newStatus: after.status,
    });

    const statusMessage = `Incident Report Update: Your report has been updated to ${after.status}.`;

    try {
      const messageId = await messaging.send({
        token: fcmToken,
        notification: {
          title: 'Incident Report Update',
          body: `Your report has been updated to ${after.status}.`,
        },
        data: {
          type: 'incident_status_change',
          reportId,
          status: after.status,
          message: statusMessage,
        },
        android: {
          priority: 'high',
          notification: {
            channelId: 'incidents',
          },
        },
      });

      logger.info('Incident report status notification sent successfully', {
        reportId,
        userId: after.userId,
        messageId,
      });
    } catch (error: unknown) {
      const errorCode = getErrorCode(error);
      if (errorCode && DEAD_TOKEN_CODES.has(errorCode)) {
        logger.warn('Removing dead FCM token for user', {
          reportId,
          userId: after.userId,
          errorCode,
        });
        await userRef.update({
          fcmToken: FieldValue.delete(),
        });
        return;
      }

      logger.error('Failed to send incident report status notification', {
        reportId,
        userId: after.userId,
        error,
      });
      throw error;
    }
  },
);
