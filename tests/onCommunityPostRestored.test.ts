import functionsTest from 'firebase-functions-test';

import type { CommunityPost } from '../src/types';

const testEnv = functionsTest();

// --- Mock the Firebase Admin SDK wrapper ---------------------------------------

const userGetMock = jest.fn();
const userUpdateMock = jest.fn();
const docMock = jest.fn((id: string) => ({
  id,
  get: userGetMock,
  update: userUpdateMock,
}));
const collectionMock = jest.fn((_collName: string) => ({
  doc: docMock,
}));
const sendMock = jest.fn();
const deleteSentinel = { __delete__: true };

jest.mock('../src/utils/firebase', () => ({
  db: {
    collection: (coll: string) => collectionMock(coll),
  },
  messaging: {
    send: (...args: unknown[]) => sendMock(...args),
  },
  FieldValue: {
    delete: jest.fn(() => deleteSentinel),
  },
}));

import { onCommunityPostRestored } from '../src/admin/onCommunityPostRestored';

// --- Fixtures & Helpers --------------------------------------------------------

const BASE_POST: Omit<CommunityPost, 'createdAt'> = {
  id: 'post-1',
  authorId: 'author-123',
  authorName: 'Asha',
  authorPhotoUrl: '',
  content: 'Suspicious individual spotted near bus terminal.',
  type: 'text',
  isAnonymous: false,
  locationUrl: null,
  imageUrl: null,
  city: 'Pune',
  state: 'Maharashtra',
  reportCount: 3,
  isHidden: true,
};

function runUpdate(
  beforeOverrides: Partial<Omit<CommunityPost, 'createdAt'>> | null,
  afterOverrides: Partial<Omit<CommunityPost, 'createdAt'>> | null,
  postId = 'post-1',
): Promise<void> {
  const beforeSnap =
    beforeOverrides !== null
      ? testEnv.firestore.makeDocumentSnapshot(
          { ...BASE_POST, ...beforeOverrides },
          `community/${postId}`,
        )
      : testEnv.firestore.makeDocumentSnapshot({}, `community/${postId}`);

  const afterSnap =
    afterOverrides !== null
      ? testEnv.firestore.makeDocumentSnapshot(
          { ...BASE_POST, ...afterOverrides },
          `community/${postId}`,
        )
      : testEnv.firestore.makeDocumentSnapshot({}, `community/${postId}`);

  const change = testEnv.makeChange(beforeSnap, afterSnap);
  const wrapped = testEnv.wrap(onCommunityPostRestored);
  return wrapped({ data: change, params: { postId } } as never);
}

afterAll(() => {
  testEnv.cleanup();
});

// --- Tests ---------------------------------------------------------------------

describe('onCommunityPostRestored', () => {
  it('does nothing when event carried no data', async () => {
    const wrapped = testEnv.wrap(onCommunityPostRestored);
    await wrapped({ data: undefined, params: { postId: 'post-1' } } as never);

    expect(collectionMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does nothing when before or after document data is empty', async () => {
    await runUpdate(null, null);

    expect(collectionMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does nothing when isHidden remained false', async () => {
    await runUpdate({ isHidden: false, reportCount: 1 }, { isHidden: false, reportCount: 2 });

    expect(collectionMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does nothing when isHidden remained true', async () => {
    await runUpdate({ isHidden: true, reportCount: 4 }, { isHidden: true, reportCount: 5 });

    expect(collectionMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does nothing when isHidden transitioned from false to true (hidden, not restored)', async () => {
    await runUpdate({ isHidden: false, reportCount: 2 }, { isHidden: true, reportCount: 3 });

    expect(collectionMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does nothing when post has no valid authorId', async () => {
    await runUpdate({ isHidden: true, authorId: '' }, { isHidden: false, authorId: '' });

    expect(collectionMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does nothing when author user document does not exist', async () => {
    userGetMock.mockResolvedValueOnce({
      exists: false,
      data: () => undefined,
    });

    await runUpdate({ isHidden: true }, { isHidden: false });

    expect(collectionMock).toHaveBeenCalledWith('users');
    expect(docMock).toHaveBeenCalledWith('author-123');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does nothing when author user has no fcmToken', async () => {
    userGetMock.mockResolvedValueOnce({
      exists: true,
      data: () => ({ email: 'author@test.org' }),
    });

    await runUpdate({ isHidden: true }, { isHidden: false });

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does nothing when author user fcmToken is whitespace only', async () => {
    userGetMock.mockResolvedValueOnce({
      exists: true,
      data: () => ({ fcmToken: '   ' }),
    });

    await runUpdate({ isHidden: true }, { isHidden: false });

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sends notification to author when post transitions from hidden to restored', async () => {
    userGetMock.mockResolvedValueOnce({
      exists: true,
      data: () => ({ fcmToken: 'valid-author-token' }),
    });
    sendMock.mockResolvedValueOnce('msg-restored-1');

    await runUpdate({ isHidden: true }, { isHidden: false });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith({
      token: 'valid-author-token',
      notification: {
        title: '✅ Post Restored',
        body: 'Your post has been reviewed by moderators and restored to the community.',
      },
      data: {
        type: 'post_restored',
        postId: 'post-1',
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'community',
        },
      },
    });
  });

  it('removes dead token when error is messaging/registration-token-not-registered', async () => {
    userGetMock.mockResolvedValueOnce({
      exists: true,
      data: () => ({ fcmToken: 'dead-author-tok-1' }),
    });
    sendMock.mockRejectedValueOnce({
      code: 'messaging/registration-token-not-registered',
      message: 'Token unregistered',
    });
    userUpdateMock.mockResolvedValueOnce(undefined);

    await runUpdate({ isHidden: true }, { isHidden: false });

    expect(userUpdateMock).toHaveBeenCalledTimes(1);
    expect(userUpdateMock).toHaveBeenCalledWith({
      fcmToken: deleteSentinel,
    });
  });

  it('removes dead token when error is messaging/invalid-registration-token', async () => {
    userGetMock.mockResolvedValueOnce({
      exists: true,
      data: () => ({ fcmToken: 'dead-author-tok-2' }),
    });
    sendMock.mockRejectedValueOnce({
      code: 'messaging/invalid-registration-token',
      message: 'Token invalid',
    });
    userUpdateMock.mockResolvedValueOnce(undefined);

    await runUpdate({ isHidden: true }, { isHidden: false });

    expect(userUpdateMock).toHaveBeenCalledTimes(1);
    expect(userUpdateMock).toHaveBeenCalledWith({
      fcmToken: deleteSentinel,
    });
  });

  it('rethrows unexpected error and does not remove token', async () => {
    userGetMock.mockResolvedValueOnce({
      exists: true,
      data: () => ({ fcmToken: 'author-token' }),
    });
    const serverError = {
      code: 'messaging/server-unavailable',
      message: 'Server down',
    };
    sendMock.mockRejectedValueOnce(serverError);

    await expect(runUpdate({ isHidden: true }, { isHidden: false })).rejects.toEqual(serverError);
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it('rethrows generic non-firebase error', async () => {
    userGetMock.mockResolvedValueOnce({
      exists: true,
      data: () => ({ fcmToken: 'author-token' }),
    });
    const genericError = new Error('Unexpected crash in author notification');
    sendMock.mockRejectedValueOnce(genericError);

    await expect(runUpdate({ isHidden: true }, { isHidden: false })).rejects.toThrow(
      'Unexpected crash in author notification',
    );
    expect(userUpdateMock).not.toHaveBeenCalled();
  });
});
