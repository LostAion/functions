/**
 * Unsafe area domain models mirroring Firestore `unsafeAreas/{areaId}`.
 * Keeps parity with admin/src/types/firestore.types.ts.
 */

export type UnsafeAreaCategory = 'poorly_lit' | 'isolated' | 'harassment_reported' | 'other';

export type UnsafeAreaStatus = 'pending' | 'approved';

export type PinColor = 'orange' | 'red';

/** Mirrors Firestore `unsafeAreas/{areaId}`. */
export interface UnsafeArea {
  id: string;
  reportedBy: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  title: string;
  description: string;
  category: UnsafeAreaCategory;
  status: UnsafeAreaStatus;
  pinColor: PinColor;
  upvotes: number;
  downvotes: number;
  voterIds: string[];
  createdAt: FirebaseFirestore.Timestamp;
}
