import functionsTest from 'firebase-functions-test';

import type { NewsItem } from '../src/types';

const testEnv = functionsTest();

// --- Mock the Firebase Admin SDK wrapper ---------------------------------------

const sendMock = jest.fn();

jest.mock('../src/utils/firebase', () => ({
  db: {
    collection: jest.fn(),
  },
  messaging: {
    send: (...args: unknown[]) => sendMock(...args),
  },
  FieldValue: {
    delete: jest.fn(),
  },
}));

import { onNewNews } from '../src/notifications/onNewNews';

// --- Fixtures & Helpers --------------------------------------------------------

const BASE_NEWS: Omit<NewsItem, 'publishedAt'> = {
  id: 'news-1',
  title: 'City Safety Advisory Issued',
  summary: 'Police have stepped up patrols in metro transit areas.',
  content: 'Comprehensive safety measures have been implemented around transit stations...',
  imageUrl: 'https://example.com/advisory.jpg',
  category: 'Advisory',
  isPublished: false,
};

function runChange(
  beforeData: Partial<Omit<NewsItem, 'publishedAt'>> | null,
  afterData: Partial<Omit<NewsItem, 'publishedAt'>> | null,
  newsId = 'news-1',
): Promise<void> {
  const beforeSnap =
    beforeData !== null
      ? testEnv.firestore.makeDocumentSnapshot({ ...BASE_NEWS, ...beforeData }, `news/${newsId}`)
      : testEnv.firestore.makeDocumentSnapshot({}, `news/${newsId}`);

  const afterSnap =
    afterData !== null
      ? testEnv.firestore.makeDocumentSnapshot({ ...BASE_NEWS, ...afterData }, `news/${newsId}`)
      : testEnv.firestore.makeDocumentSnapshot({}, `news/${newsId}`);

  const change = testEnv.makeChange(beforeSnap, afterSnap);
  const wrapped = testEnv.wrap(onNewNews);
  return wrapped({ data: change, params: { newsId } } as never);
}

afterAll(() => {
  testEnv.cleanup();
});

// --- Tests ---------------------------------------------------------------------

describe('onNewNews', () => {
  it('does nothing when event carried no data', async () => {
    const wrapped = testEnv.wrap(onNewNews);
    await wrapped({ data: undefined, params: { newsId: 'news-1' } } as never);

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does nothing when document is deleted (after does not exist)', async () => {
    await runChange({ isPublished: true }, null);

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does nothing when created with isPublished = false', async () => {
    await runChange(null, { isPublished: false });

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does nothing when updated while remaining unpublished', async () => {
    await runChange({ isPublished: false }, { isPublished: false, title: 'Draft Revision' });

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does nothing when updated but was already published (isPublished remained true)', async () => {
    await runChange({ isPublished: true }, { isPublished: true, summary: 'Updated summary text' });

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('dispatches to topic "news" when newly created with isPublished = true', async () => {
    sendMock.mockResolvedValueOnce('msg-news-123');

    await runChange(null, {
      isPublished: true,
      title: 'Night Patrolling Increased',
      summary: 'Additional police patrol vans deployed near universities.',
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith({
      topic: 'news',
      notification: {
        title: '📢 Safety Advisory / News',
        body: 'Additional police patrol vans deployed near universities.',
      },
      data: {
        type: 'news',
        newsId: 'news-1',
        title: 'Night Patrolling Increased',
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'safety_alerts',
        },
      },
    });
  });

  it('falls back to title for notification body when summary is empty', async () => {
    sendMock.mockResolvedValueOnce('msg-news-fallback');

    await runChange(null, {
      isPublished: true,
      title: 'Emergency Helpline System Upgrade',
      summary: '',
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        notification: {
          title: '📢 Safety Advisory / News',
          body: 'Emergency Helpline System Upgrade',
        },
      }),
    );
  });

  it('dispatches to topic "news" when updated from isPublished = false to true', async () => {
    sendMock.mockResolvedValueOnce('msg-news-published');

    await runChange(
      { isPublished: false, title: 'Safe Travel Guidelines Released' },
      { isPublished: true, title: 'Safe Travel Guidelines Released' },
    );

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'news',
        data: expect.objectContaining({
          type: 'news',
          newsId: 'news-1',
          title: 'Safe Travel Guidelines Released',
        }),
      }),
    );
  });

  it('rethrows error when messaging.send fails', async () => {
    const networkError = new Error('FCM connection reset');
    sendMock.mockRejectedValueOnce(networkError);

    await expect(runChange({ isPublished: false }, { isPublished: true })).rejects.toThrow(
      'FCM connection reset',
    );
  });
});
