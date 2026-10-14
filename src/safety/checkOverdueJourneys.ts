import * as admin from 'firebase-admin';
import { logger } from 'firebase-functions';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import type { SafeJourneySessionDoc } from '../types';
import { db, FieldValue, messaging } from '../utils/firebase';

interface UserProfile {
  fcmToken?: string;
}

export const SESSIONS_COLLECTION = 'safeJourneySessions';
export const ALERT_LOGS_COLLECTION = 'alertLogs';

/**
 * Scheduled watchdog function running every 1 minute.
 *
 * Scans for active safe journey sessions that have exceeded their
 * expected arrival time without arriving or extending the ETA.
 * Marks overdue sessions as `alert_sent`, dispatches emergency push alerts
 * to the traveler, and logs the watchdog action in Firestore.
 */
export const checkOverdueJourneys = onSchedule(
  {
    schedule: 'every 1 minutes',
    timeZone: 'Asia/Kolkata',
    maxInstances: 1,
  },
  async (): Promise<void> => {
    const now = admin.firestore.Timestamp.now();

    logger.info('checkOverdueJourneys: checking for overdue active safe journey sessions', {
      checkedAt: now.toDate().toISOString(),
    });

    try {
      const snapshot = await db
        .collection(SESSIONS_COLLECTION)
        .where('status', '==', 'active')
        .where('expectedArrivalAt', '<=', now)
        .get();

      if (snapshot.empty) {
        logger.info('checkOverdueJourneys: no overdue sessions found');
        return;
      }

      logger.warn(`checkOverdueJourneys: found ${snapshot.docs.length} overdue session(s)`);

      const batch = db.batch();
      const notificationsToSend: Array<{
        token: string;
        title: string;
        body: string;
        data: Record<string, string>;
      }> = [];

      for (const doc of snapshot.docs) {
        const session = doc.data() as SafeJourneySessionDoc;
        const sessionId = doc.id;

        // 1. Mark session as alert_sent
        batch.update(doc.ref, {
          status: 'alert_sent',
          alertSentAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

        // 2. Write alert audit log
        const alertLogRef = db.collection(ALERT_LOGS_COLLECTION).doc();
        batch.set(alertLogRef, {
          type: 'safe_journey_overdue',
          sessionId,
          userId: session.userId,
          destinationName: session.destinationName ?? '',
          expectedArrivalAt: session.expectedArrivalAt,
          createdAt: FieldValue.serverTimestamp(),
        });

        logger.warn('Safe journey is overdue — sending alert', {
          sessionId,
          userId: session.userId,
          destinationName: session.destinationName,
          expectedArrivalAt: session.expectedArrivalAt?.toDate().toISOString(),
        });

        // 3. Look up traveler's FCM token to dispatch push notification
        if (session.userId) {
          try {
            const userSnap = await db.collection('users').doc(session.userId).get();
            const userData = userSnap.data() as UserProfile | undefined;
            const fcmToken = userData?.fcmToken;
            if (fcmToken && typeof fcmToken === 'string' && fcmToken.trim().length > 0) {
              notificationsToSend.push({
                token: fcmToken,
                title: '🚨 Safe Journey Overdue Alert',
                body: `You have not confirmed your arrival at ${session.destinationName || 'your destination'}. Check in now or emergency contacts will be notified.`,
                data: {
                  type: 'safe_journey',
                  sessionId,
                },
              });
            }
          } catch (userErr: unknown) {
            logger.error('Failed to fetch user profile for overdue journey alert', {
              sessionId,
              userId: session.userId,
              error: userErr,
            });
          }
        }
      }

      await batch.commit();

      // Dispatch push notifications
      for (const notification of notificationsToSend) {
        try {
          await messaging.send({
            token: notification.token,
            notification: {
              title: notification.title,
              body: notification.body,
            },
            data: notification.data,
            android: {
              priority: 'high',
            },
            apns: {
              payload: {
                aps: {
                  sound: 'default',
                  badge: 1,
                },
              },
            },
          });
        } catch (pushErr: unknown) {
          logger.error('Failed to send FCM push notification for overdue journey', {
            token: notification.token,
            error: pushErr,
          });
        }
      }

      logger.info('checkOverdueJourneys: completed processing overdue sessions', {
        processedCount: snapshot.docs.length,
      });
    } catch (error: unknown) {
      logger.error('checkOverdueJourneys: execution failed', { error });
      throw error;
    }
  },
);
