import functionsTest from 'firebase-functions-test';

import type { Law } from '../src/types';

const testEnv = functionsTest();

// --- Mock the Firebase Admin SDK wrapper ---------------------------------------

const sendMock = jest.fn();
const docUpdateMock = jest.fn();
const collectionMock = jest.fn((_collName: string) => ({
  doc: (_id: string) => ({ update: docUpdateMock }),
}));
const timestampSentinel = { __serverTimestamp__: true };

jest.mock('../src/utils/firebase', () => ({
  db: {
    collection: (coll: string) => collectionMock(coll),
  },
  messaging: {
    send: (...args: unknown[]) => sendMock(...args),
  },
  FieldValue: {
    delete: jest.fn(),
    serverTimestamp: jest.fn(() => timestampSentinel),
  },
}));

import { onNewLaw } from '../src/notifications/onNewLaw';

// --- Fixtures & Helpers --------------------------------------------------------

const BASE_LAW: Law = {
  id: 'law-1',
  title: 'Right to Free Legal Aid',
  shortDescription: 'Free legal services are provided to women in need.',
  fullContent:
    'Under the Legal Services Authorities Act, eligible persons can access free legal aid.',
  category: 'Legal Aid',
  tags: ['legal-aid', 'women-rights'],
  order: 1,
  isPublished: false,
};

function runChange(
  beforeData: Partial<Law> | null,
  afterData: Partial<Law> | null,
  lawId = 'law-1',
): Promise<void> {
  const beforeSnap =
    beforeData !== null
      ? testEnv.firestore.makeDocumentSnapshot({ ...BASE_LAW, ...beforeData }, `laws/${lawId}`)
      : testEnv.firestore.makeDocumentSnapshot({}, `laws/${lawId}`);

  const afterSnap =
    afterData !== null
      ? testEnv.firestore.makeDocumentSnapshot({ ...BASE_LAW, ...afterData }, `laws/${lawId}`)
      : testEnv.firestore.makeDocumentSnapshot({}, `laws/${lawId}`);

  const change = testEnv.makeChange(beforeSnap, afterSnap);
  const wrapped = testEnv.wrap(onNewLaw);
  return wrapped({ data: change, params: { lawId } } as never);
}

afterAll(() => {
  testEnv.cleanup();
});

// --- Tests ---------------------------------------------------------------------

describe('onNewLaw', () => {
  it('does nothing when event carried no data', async () => {
    const wrapped = testEnv.wrap(onNewLaw);
    await wrapped({ data: undefined, params: { lawId: 'law-1' } } as never);

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
    await runChange({ isPublished: false }, { isPublished: false, title: 'Updated Title' });

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does nothing when updated but was already published (isPublished remained true)', async () => {
    await runChange({ isPublished: true }, { isPublished: true, title: 'Revised Rights' });

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('dispatches to topic "laws" when newly created with isPublished = true', async () => {
    sendMock.mockResolvedValueOnce('msg-law-123');

    await runChange(null, {
      isPublished: true,
      title: 'Right to Zero FIR',
      shortDescription: 'File an FIR at any police station regardless of jurisdiction.',
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith({
      topic: 'laws',
      notification: {
        title: '📜 New Legal Right Published',
        body: 'File an FIR at any police station regardless of jurisdiction.',
      },
      data: {
        type: 'law',
        lawId: 'law-1',
        title: 'Right to Zero FIR',
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'safety_alerts',
        },
      },
    });
  });

  it('falls back to title for notification body when shortDescription is empty', async () => {
    sendMock.mockResolvedValueOnce('msg-law-fallback');

    await runChange(null, {
      isPublished: true,
      title: 'Workplace Safety Rights',
      shortDescription: '',
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        notification: {
          title: '📜 New Legal Right Published',
          body: 'Workplace Safety Rights',
        },
      }),
    );
  });

  it('dispatches to topic "laws" when updated from isPublished = false to true', async () => {
    sendMock.mockResolvedValueOnce('msg-law-published');

    await runChange(
      { isPublished: false, title: 'Protection of Women from Domestic Violence Act' },
      { isPublished: true, title: 'Protection of Women from Domestic Violence Act' },
    );

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'laws',
        data: expect.objectContaining({
          type: 'law',
          lawId: 'law-1',
          title: 'Protection of Women from Domestic Violence Act',
        }),
      }),
    );
  });

  it('rethrows error when messaging.send fails', async () => {
    const networkError = new Error('FCM network failure');
    sendMock.mockRejectedValueOnce(networkError);

    await expect(runChange({ isPublished: false }, { isPublished: true })).rejects.toThrow(
      'FCM network failure',
    );
  });

  it('marks the document as notified after a successful send', async () => {
    sendMock.mockResolvedValueOnce('msg-mark');
    docUpdateMock.mockResolvedValueOnce(undefined);

    await runChange({ isPublished: false }, { isPublished: true });

    expect(collectionMock).toHaveBeenCalledWith('laws');
    expect(docUpdateMock).toHaveBeenCalledWith({ notifiedAt: timestampSentinel });
  });

  it('does not re-notify when republished after an earlier notification', async () => {
    await runChange(
      { isPublished: false, notifiedAt: new Date() as never },
      { isPublished: true, notifiedAt: new Date() as never },
    );

    expect(sendMock).not.toHaveBeenCalled();
    expect(docUpdateMock).not.toHaveBeenCalled();
  });

  it('does not throw when marking as notified fails after a successful send', async () => {
    sendMock.mockResolvedValueOnce('msg-mark-fail');
    docUpdateMock.mockRejectedValueOnce(new Error('write failed'));

    await expect(runChange({ isPublished: false }, { isPublished: true })).resolves.toBeUndefined();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
