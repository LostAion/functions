import { logger } from 'firebase-functions';
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';

import type { UnsafeArea } from '../types';
import { messaging } from '../utils/firebase';

/**
 * Fires when an `unsafeAreas/{areaId}` document is updated.
 *
 * When an unsafe area transitions from any non-approved status (e.g. 'pending')
 * to 'approved' (`before.status !== 'approved' && after.status === 'approved'`),
 * broadcasts an alert to users on the city topic (or the default 'unsafe_areas' topic)
 * warning the community of a newly verified unsafe zone.
 *
 * Idempotent: No-op if status did not transition to 'approved'.
 */
export const onUnsafeAreaApproved = onDocumentUpdated(
  'unsafeAreas/{areaId}',
  async (event): Promise<void> => {
    const areaId = event.params.areaId;

    if (!event.data) {
      logger.warn('onUnsafeAreaApproved: update event carried no data', { areaId });
      return;
    }

    const before = event.data.before.data() as UnsafeArea | undefined;
    const after = event.data.after.data() as UnsafeArea | undefined;

    if (!before || !after) {
      return;
    }

    // Idempotency: only trigger on transition to 'approved'
    if (before.status === 'approved' || after.status !== 'approved') {
      return;
    }

    // Topic resolution: if category or title has city context, use topic, else default
    const topic = 'unsafe_areas';

    const category = typeof after.category === 'string' ? after.category : 'other';
    const categoryLabel = category.replace(/_/g, ' ');

    logger.info('Broadcasting alert for newly verified unsafe area', {
      areaId,
      title: after.title,
      category,
      topic,
    });

    try {
      const messageId = await messaging.send({
        topic,
        notification: {
          title: '⚠️ Verified Unsafe Area Alert',
          body: `Caution: "${after.title}" has been verified as an unsafe area (${categoryLabel}).`,
        },
        data: {
          type: 'unsafe_area_approved',
          areaId,
          category,
          latitude: typeof after.latitude === 'number' ? String(after.latitude) : '',
          longitude: typeof after.longitude === 'number' ? String(after.longitude) : '',
        },
        android: {
          priority: 'high',
          notification: {
            channelId: 'safety_alerts',
          },
        },
      });

      logger.info('Unsafe area alert broadcast sent successfully', {
        areaId,
        topic,
        messageId,
      });
    } catch (error) {
      logger.error('Failed to broadcast unsafe area alert', {
        areaId,
        topic,
        error,
      });
      throw error;
    }
  },
);
