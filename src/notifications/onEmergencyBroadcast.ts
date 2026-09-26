import { logger } from 'firebase-functions';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';

import type { EmergencyBroadcast } from '../types';
import { messaging } from '../utils/firebase';

/**
 * Resolves the FCM topic name for an emergency broadcast.
 * Returns the sanitized city topic if specified, or `'emergency_alerts'` if omitted or 'all'.
 */
function resolveTopic(city?: string): string {
  if (!city) {
    return 'emergency_alerts';
  }
  const trimmed = city.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === 'all') {
    return 'emergency_alerts';
  }
  return trimmed.replace(/\s+/g, '_');
}

/**
 * Fires when an `emergencyBroadcasts/{broadcastId}` document is created.
 *
 * Dispatches a high-priority FCM notification to the topic `'emergency_alerts'`
 * (or city-specific topic if specified).
 */
export const onEmergencyBroadcast = onDocumentCreated(
  'emergencyBroadcasts/{broadcastId}',
  async (event): Promise<void> => {
    const broadcastId = event.params.broadcastId;

    if (!event.data) {
      logger.warn('onEmergencyBroadcast: create event carried no data', { broadcastId });
      return;
    }

    const broadcast = event.data.data() as EmergencyBroadcast | undefined;
    if (!broadcast) {
      logger.warn('onEmergencyBroadcast: document data is empty', { broadcastId });
      return;
    }

    const topic = resolveTopic(broadcast.city);

    logger.info('Dispatching emergency broadcast notification', {
      broadcastId,
      title: broadcast.title,
      city: broadcast.city,
      topic,
    });

    try {
      const messageId = await messaging.send({
        topic,
        notification: {
          title: `🚨 Emergency Alert: ${broadcast.title}`,
          body: broadcast.message,
        },
        data: {
          type: 'emergency_broadcast',
          broadcastId,
          title: broadcast.title ?? '',
          severity: broadcast.severity ?? 'critical',
          city: broadcast.city ?? '',
        },
        android: {
          priority: 'high',
          notification: {
            channelId: 'emergency_alerts',
            priority: 'max',
          },
        },
      });

      logger.info('Emergency broadcast notification sent successfully', {
        broadcastId,
        topic,
        messageId,
      });
    } catch (error: unknown) {
      logger.error('Failed to send emergency broadcast notification', {
        broadcastId,
        topic,
        error,
      });
      throw error;
    }
  },
);
