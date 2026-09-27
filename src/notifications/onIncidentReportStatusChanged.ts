import { logger } from 'firebase-functions';
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';

import type { IncidentReport, IncidentStatus } from '../types';
import { db, messaging } from '../utils/firebase';
import { isDeadTokenError, removeDeadToken } from '../utils/fcm';

/** User-facing wording for each incident status. */
const STATUS_LABELS: Record<IncidentStatus, string> = {
  submitted: 'submitted',
  under_review: 'under review',
  resolved: 'resolved',
};

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

    const statusLabel = STATUS_LABELS[after.status] ?? String(after.status).replace(/_/g, ' ');
    const statusBody = `Your report has been updated to ${statusLabel}.`;
    const statusMessage = `Incident Report Update: ${statusBody}`;

    try {
      const messageId = await messaging.send({
        token: fcmToken,
        notification: {
          title: 'Incident Report Update',
          body: statusBody,
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
      if (isDeadTokenError(error)) {
        const removed = await removeDeadToken(userRef, fcmToken);
        logger.warn('Dead FCM token for user', {
          reportId,
          userId: after.userId,
          removed,
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
