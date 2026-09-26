/**
 * Incident report domain models mirroring Firestore `incidentReports/{reportId}`.
 * Keeps parity with admin/src/types/firestore.types.ts.
 */

export type IncidentStatus = 'submitted' | 'under_review' | 'resolved';

/** Mirrors Firestore `incidentReports/{reportId}`. `adminNote` is admin-only. */
export interface IncidentReport {
  id: string;
  userId: string;
  title: string;
  description: string;
  latitude: number;
  longitude: number;
  photoUrls: string[];
  createdAt: FirebaseFirestore.Timestamp;
  status: IncidentStatus;
  adminNote?: string;
}
