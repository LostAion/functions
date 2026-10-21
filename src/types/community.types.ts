/**
 * Mirror of the app repo's `src/types/community.types.ts`. These types describe
 * the Firestore `community/{postId}` document and MUST stay in sync with
 * surakshak-redx-org/app (Phase 5 — Community).
 */

export type PostType = 'text' | 'location' | 'image' | 'help_request' | 'incident';

/** Mirrors Firestore `community/{postId}`. */
export interface CommunityPost {
  id: string;
  authorId: string;
  authorName: string;
  authorPhotoUrl: string;
  content: string;
  type: PostType;
  isAnonymous: boolean;
  locationUrl: string | null;
  imageUrl: string | null;
  city: string;
  state: string;
  reportCount: number;
  isHidden: boolean;
  createdAt: FirebaseFirestore.Timestamp;
}
