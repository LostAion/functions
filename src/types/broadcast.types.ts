/**
 * Emergency broadcast domain models mirroring Firestore `emergencyBroadcasts/{broadcastId}`.
 */

export type BroadcastSeverity = 'critical' | 'high' | 'warning';

/** Mirrors Firestore `emergencyBroadcasts/{broadcastId}`. */
export interface EmergencyBroadcast {
  id: string;
  title: string;
  message: string;
  city: string;
  severity: BroadcastSeverity;
  createdBy: string;
  createdAt: FirebaseFirestore.Timestamp;
}
