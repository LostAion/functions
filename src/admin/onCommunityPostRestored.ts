import { logger } from 'firebase-functions';
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';

import type { CommunityPost } from '../types';
import { db, messaging } from '../utils/firebase';
import { isDeadTokenError, removeDeadToken } from '../utils/fcm';

interface UserProfile {
  fcmToken?: string;
}

/**
 * Fires when a `community/{postId}` document is updated.
 *
 * When an admin restores an auto-hidden post (`before.isHidden === true && after.isHidden === false`),
 * notifies the post author that their content was reviewed and reinstated.
 *
 * Automatically prunes expired or invalid FCM registration tokens.
 * Idempotent: No-op if post was not transitioning from hidden to visible.
 */
export const onCommunityPostRestored = onDocumentUpdated(
  'community/{postId}',
  async (event): Promise<void> => {
    const postId = event.params.postId;

    if (!event.data) {
      logger.warn('onCommunityPostRestored: update event carried no data', { postId });
      return;
    }

    const before = event.data.before.data() as CommunityPost | undefined;
    const after = event.data.after.data() as CommunityPost | undefined;

    if (!before || !after) {
      return;
    }

    // Idempotency: only trigger on transition from hidden to visible
    const justRestored = before.isHidden === true && after.isHidden === false;
    if (!justRestored) {
      return;
    }

    if (!after.authorId || typeof after.authorId !== 'string') {
      logger.warn('onCommunityPostRestored: post has no valid authorId', {
        postId,
        authorId: after.authorId,
      });
      return;
    }

    logger.info('Community post restored by admin — notifying author', {
      postId,
      authorId: after.authorId,
      city: after.city,
    });

    const userRef = db.collection('users').doc(after.authorId);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      logger.info('onCommunityPostRestored: author user document not found', {
        postId,
        authorId: after.authorId,
      });
      return;
    }

    const authorData = userSnap.data() as UserProfile | undefined;
    const fcmToken = authorData?.fcmToken;

    if (!fcmToken || typeof fcmToken !== 'string' || fcmToken.trim().length === 0) {
      logger.info('onCommunityPostRestored: author has no fcmToken', {
        postId,
        authorId: after.authorId,
      });
      return;
    }

    try {
      const messageId = await messaging.send({
        token: fcmToken,
        notification: {
          title: '✅ Post Restored',
          body: 'Your post has been reviewed by moderators and restored to the community.',
        },
        data: {
          type: 'post_restored',
          postId,
        },
        android: {
          priority: 'high',
          notification: {
            channelId: 'community',
          },
        },
      });

      logger.info('Post restored notification sent to author', {
        postId,
        authorId: after.authorId,
        messageId,
      });
    } catch (error: unknown) {
      if (isDeadTokenError(error)) {
        const removed = await removeDeadToken(userRef, fcmToken);
        logger.warn('Dead FCM token for author', {
          postId,
          authorId: after.authorId,
          removed,
        });
        return;
      }

      logger.error('Failed to send post restored notification to author', {
        postId,
        authorId: after.authorId,
        error,
      });
      throw error;
    }
  },
);
