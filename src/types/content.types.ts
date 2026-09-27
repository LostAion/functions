/**
 * Content domain models mirroring Firestore collections:
 * - `laws/{lawId}`
 * - `faqs/{faqId}`
 * - `safetyTips/{tipId}`
 * - `news/{newsId}`
 *
 * Keeps parity with admin/src/types/firestore.types.ts.
 */

/** Mirrors Firestore `laws/{lawId}`. */
export interface Law {
  id: string;
  title: string;
  shortDescription: string;
  fullContent: string;
  category: string;
  tags: string[];
  order: number;
  isPublished: boolean;
  /** Set by Cloud Functions once the publish push has been sent. */
  notifiedAt?: FirebaseFirestore.Timestamp;
}

/** Mirrors Firestore `faqs/{faqId}`. */
export interface FAQ {
  id: string;
  question: string;
  answer: string;
  category: string;
  order: number;
  isPublished: boolean;
}

/** Mirrors Firestore `safetyTips/{tipId}`. */
export interface SafetyTip {
  id: string;
  title: string;
  content: string;
  category: string;
  order: number;
  isPublished: boolean;
}

/** Mirrors Firestore `news/{newsId}`. */
export interface NewsItem {
  id: string;
  title: string;
  summary: string;
  content: string;
  imageUrl: string;
  category: string;
  publishedAt: FirebaseFirestore.Timestamp;
  isPublished: boolean;
  /** Set by Cloud Functions once the publish push has been sent. */
  notifiedAt?: FirebaseFirestore.Timestamp;
}
