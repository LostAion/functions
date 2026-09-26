import { logger } from 'firebase-functions';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';

import type { Law } from '../types';
import { messaging } from '../utils/firebase';

/**
 * Fires when a `laws/{lawId}` document is written (created, updated, or deleted).
 *
 * Dispatches an FCM push notification to the topic `'laws'` when a law becomes
 * published (either newly created with `isPublished: true`, or updated where
 * `before.isPublished === false && after.isPublished === true`).
 *
 * Idempotent: No-op if `isPublished` did not transition to `true`.
 */
export const onNewLaw = onDocumentWritten(
  'laws/{lawId}',
  async (event): Promise<void> => {
    const lawId = event.params.lawId;

    if (!event.data) {
      logger.warn('onNewLaw: write event carried no data', { lawId });
      return;
    }

    const { before, after } = event.data;

    // Document was deleted — nothing to notify
    if (!after.exists) {
      return;
    }

    const afterData = after.data() as Law | undefined;
    if (!afterData || !afterData.isPublished) {
      return;
    }

    // If updating an existing document, verify that it was not already published
    if (before.exists) {
      const beforeData = before.data() as Law | undefined;
      if (beforeData?.isPublished) {
        return;
      }
    }

    const body = afterData.shortDescription || afterData.title || '';

    logger.info('Publishing new law notification', {
      lawId,
      title: afterData.title,
    });

    try {
      const messageId = await messaging.send({
        topic: 'laws',
        notification: {
          title: '📜 New Legal Right Published',
          body,
        },
        data: {
          type: 'law',
          lawId,
          title: afterData.title ?? '',
        },
        android: {
          priority: 'high',
          notification: {
            channelId: 'safety_alerts',
          },
        },
      });

      logger.info('Law notification sent successfully', { lawId, messageId });
    } catch (error: unknown) {
      logger.error('Failed to send law notification', { lawId, error });
      throw error;
    }
  },
);
