import type { firestore } from 'firebase-admin';

export interface SafeJourneySessionDoc {
  userId: string;
  destinationName: string;
  destinationLatitude: number;
  destinationLongitude: number;
  etaMinutes: number;
  sharedWithUserIds?: string[];
  startedAt: firestore.Timestamp;
  expectedArrivalAt: firestore.Timestamp;
  status: 'active' | 'arrived' | 'cancelled' | 'alert_sent';
  alertSentAt?: firestore.FieldValue | firestore.Timestamp;
  updatedAt?: firestore.FieldValue | firestore.Timestamp;
}

export interface JourneyAlertLog {
  type: 'safe_journey_overdue';
  sessionId: string;
  userId: string;
  destinationName: string;
  expectedArrivalAt: firestore.Timestamp;
  createdAt: firestore.FieldValue | firestore.Timestamp;
}
