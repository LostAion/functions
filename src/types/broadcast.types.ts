/**
 * Emergency broadcast domain models mirroring Firestore `broadcasts/{broadcastId}`.
 */

export type BroadcastSeverity = 'critical' | 'high' | 'warning';

/** Mirrors Firestore `broadcasts/{broadcastId}`. */
export interface EmergencyBroadcast {
  id: string;
  title: string;
  message: string;
  city: string;
  severity: BroadcastSeverity;
  createdBy: string;
  createdAt: FirebaseFirestore.Timestamp;
}
