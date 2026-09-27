import { logger } from 'firebase-functions';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';

import type { NewsItem } from '../types';
import { db, FieldValue, messaging } from '../utils/firebase';

/**
 * Fires when a `news/{newsId}` document is written (created, updated, or deleted).
 *
 * Dispatches an FCM push notification to the topic `'news'` when a news item
 * becomes published (either newly created with `isPublished: true`, or updated where
 * `before.isPublished === false && after.isPublished === true`).
 *
 * Idempotent: No-op if `isPublished` did not transition to `true`, or if the
 * document already has `notifiedAt` (so unpublish → republish does not re-notify).
 */
export const onNewNews = onDocumentWritten('news/{newsId}', async (event): Promise<void> => {
  const newsId = event.params.newsId;

  if (!event.data) {
    logger.warn('onNewNews: write event carried no data', { newsId });
    return;
  }

  const { before, after } = event.data;

  // Document was deleted — nothing to notify
  if (!after.exists) {
    return;
  }

  const afterData = after.data() as NewsItem | undefined;
  if (!afterData || !afterData.isPublished) {
    return;
  }

  // Already notified on an earlier publish — don't push the same item again
  if (afterData.notifiedAt) {
    return;
  }

  // If updating an existing document, verify that it was not already published
  if (before.exists) {
    const beforeData = before.data() as NewsItem | undefined;
    if (beforeData?.isPublished) {
      return;
    }
  }

  const body = afterData.summary || afterData.title || '';

  logger.info('Publishing new news notification', {
    newsId,
    title: afterData.title,
  });

  try {
    const messageId = await messaging.send({
      topic: 'news',
      notification: {
        title: '📢 Safety Advisory / News',
        body,
      },
      data: {
        type: 'news',
        newsId,
        title: afterData.title ?? '',
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'safety_alerts',
        },
      },
    });

    logger.info('News notification sent successfully', { newsId, messageId });
  } catch (error: unknown) {
    logger.error('Failed to send news notification', { newsId, error });
    throw error;
  }

  // Mark as notified outside the send's try/catch: a failure here must not
  // cause a retry that re-sends the push.
  try {
    await db.collection('news').doc(newsId).update({
      notifiedAt: FieldValue.serverTimestamp(),
    });
  } catch (error: unknown) {
    logger.error('Failed to mark news item as notified', { newsId, error });
  }
});
