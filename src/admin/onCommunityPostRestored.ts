import { logger } from 'firebase-functions';
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';

import type { CommunityPost } from '../types';
import { db, FieldValue, messaging } from '../utils/firebase';

/** FCM error codes that indicate an invalid/dead token that should be deleted. */
const DEAD_TOKEN_CODES = new Set<string>([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
]);

interface FirebaseErrorWithCode {
  code?: string;
}

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
      const errorCode = getErrorCode(error);
      if (errorCode && DEAD_TOKEN_CODES.has(errorCode)) {
        logger.warn('Removing dead FCM token for author', {
          postId,
          authorId: after.authorId,
          errorCode,
        });
        await userRef.update({
          fcmToken: FieldValue.delete(),
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
