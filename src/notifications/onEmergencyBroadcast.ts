import { logger } from 'firebase-functions';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';

import type { EmergencyBroadcast } from '../types';
import { messaging } from '../utils/firebase';

const DEFAULT_TOPIC = 'emergency_alerts';

/**
 * Resolves the FCM topic name for an emergency broadcast.
 * Returns the sanitized city topic if specified, or `'emergency_alerts'` if omitted or 'all'.
 *
 * FCM topics only allow `[a-zA-Z0-9-_.~%]`, so other characters are stripped and
 * whitespace becomes `_`. If nothing valid remains (e.g. a non-Latin city name),
 * falls back to `'emergency_alerts'` so the alert is still delivered.
 */
function resolveTopic(city?: string): string {
  if (!city) {
    return DEFAULT_TOPIC;
  }
  const trimmed = city.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === 'all') {
    return DEFAULT_TOPIC;
  }
  const topic = trimmed
    .replace(/[^a-zA-Z0-9\s\-_.~%]/g, '')
    .trim()
    .replace(/\s+/g, '_');
  if (topic.length === 0) {
    logger.warn('onEmergencyBroadcast: city has no topic-safe characters, using default topic', {
      city,
    });
    return DEFAULT_TOPIC;
  }
  return topic;
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
