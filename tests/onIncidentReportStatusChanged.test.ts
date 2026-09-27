import functionsTest from 'firebase-functions-test';

import type { IncidentReport } from '../src/types';

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
const txGetMock = jest.fn();

jest.mock('../src/utils/firebase', () => ({
  db: {
    collection: (coll: string) => collectionMock(coll),
    runTransaction: (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        get: txGetMock,
        update: (_ref: unknown, data: unknown) => userUpdateMock(data),
      }),
  },
  messaging: {
    send: (...args: unknown[]) => sendMock(...args),
  },
  FieldValue: {
    delete: jest.fn(() => deleteSentinel),
  },
}));

import { onIncidentReportStatusChanged } from '../src/notifications/onIncidentReportStatusChanged';

// --- Fixtures & Helpers --------------------------------------------------------

const BASE_INCIDENT: Omit<IncidentReport, 'createdAt'> = {
  id: 'rep-1',
  userId: 'user-1',
  title: 'Street harassment incident',
  description: 'Suspicious activity near the junction.',
  latitude: 18.5204,
  longitude: 73.8567,
  photoUrls: [],
  status: 'submitted',
};

function runUpdate(
  beforeOverrides: Partial<Omit<IncidentReport, 'createdAt'>> | null,
  afterOverrides: Partial<Omit<IncidentReport, 'createdAt'>> | null,
  reportId = 'rep-1',
): Promise<void> {
  const beforeSnap =
    beforeOverrides !== null
      ? testEnv.firestore.makeDocumentSnapshot(
          { ...BASE_INCIDENT, ...beforeOverrides },
          `incidentReports/${reportId}`,
        )
      : testEnv.firestore.makeDocumentSnapshot({}, `incidentReports/${reportId}`);

  const afterSnap =
    afterOverrides !== null
      ? testEnv.firestore.makeDocumentSnapshot(
          { ...BASE_INCIDENT, ...afterOverrides },
          `incidentReports/${reportId}`,
        )
      : testEnv.firestore.makeDocumentSnapshot({}, `incidentReports/${reportId}`);

  const change = testEnv.makeChange(beforeSnap, afterSnap);
  const wrapped = testEnv.wrap(onIncidentReportStatusChanged);
  return wrapped({ data: change, params: { reportId } } as never);
}

afterAll(() => {
  testEnv.cleanup();
});

// --- Tests ---------------------------------------------------------------------

describe('onIncidentReportStatusChanged', () => {
  it('does nothing when event carried no data', async () => {
    const wrapped = testEnv.wrap(onIncidentReportStatusChanged);
    await wrapped({ data: undefined, params: { reportId: 'rep-1' } } as never);

    expect(collectionMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does nothing when status did not change', async () => {
    await runUpdate(
      { status: 'submitted', adminNote: 'note 1' },
      { status: 'submitted', adminNote: 'note 2' },
    );

    expect(collectionMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does nothing when report has no valid userId', async () => {
    await runUpdate({ status: 'submitted', userId: '' }, { status: 'under_review', userId: '' });

    expect(collectionMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does nothing when victim user document does not exist', async () => {
    userGetMock.mockResolvedValueOnce({
      exists: false,
      data: () => undefined,
    });

    await runUpdate({ status: 'submitted' }, { status: 'under_review' });

    expect(collectionMock).toHaveBeenCalledWith('users');
    expect(docMock).toHaveBeenCalledWith('user-1');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does nothing when victim user has no fcmToken', async () => {
    userGetMock.mockResolvedValueOnce({
      exists: true,
      data: () => ({ email: 'victim@test.org' }),
    });

    await runUpdate({ status: 'submitted' }, { status: 'under_review' });

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does nothing when victim user fcmToken is whitespace only', async () => {
    userGetMock.mockResolvedValueOnce({
      exists: true,
      data: () => ({ fcmToken: '   ' }),
    });

    await runUpdate({ status: 'submitted' }, { status: 'under_review' });

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sends notification when status transitions from submitted to under_review', async () => {
    userGetMock.mockResolvedValueOnce({
      exists: true,
      data: () => ({ fcmToken: 'valid-victim-token' }),
    });
    sendMock.mockResolvedValueOnce('msg-inc-1');

    await runUpdate({ status: 'submitted' }, { status: 'under_review' });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith({
      token: 'valid-victim-token',
      notification: {
        title: 'Incident Report Update',
        body: 'Your report has been updated to under review.',
      },
      data: {
        type: 'incident_status_change',
        reportId: 'rep-1',
        status: 'under_review',
        message: 'Incident Report Update: Your report has been updated to under review.',
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'incidents',
        },
      },
    });
  });

  it('sends notification when status transitions from under_review to resolved', async () => {
    userGetMock.mockResolvedValueOnce({
      exists: true,
      data: () => ({ fcmToken: 'valid-victim-token' }),
    });
    sendMock.mockResolvedValueOnce('msg-inc-2');

    await runUpdate({ status: 'under_review' }, { status: 'resolved' });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'valid-victim-token',
        notification: {
          title: 'Incident Report Update',
          body: 'Your report has been updated to resolved.',
        },
        data: expect.objectContaining({
          status: 'resolved',
        }),
      }),
    );
  });

  it('removes dead token when error is messaging/registration-token-not-registered', async () => {
    userGetMock.mockResolvedValueOnce({
      exists: true,
      data: () => ({ fcmToken: 'dead-tok-1' }),
    });
    txGetMock.mockResolvedValueOnce({ exists: true, get: () => 'dead-tok-1' });
    sendMock.mockRejectedValueOnce({
      code: 'messaging/registration-token-not-registered',
      message: 'Token unregistered',
    });
    userUpdateMock.mockResolvedValueOnce(undefined);

    await runUpdate({ status: 'submitted' }, { status: 'under_review' });

    expect(userUpdateMock).toHaveBeenCalledTimes(1);
    expect(userUpdateMock).toHaveBeenCalledWith({
      fcmToken: deleteSentinel,
    });
  });

  it('removes dead token when error is messaging/invalid-registration-token', async () => {
    userGetMock.mockResolvedValueOnce({
      exists: true,
      data: () => ({ fcmToken: 'dead-tok-2' }),
    });
    txGetMock.mockResolvedValueOnce({ exists: true, get: () => 'dead-tok-2' });
    sendMock.mockRejectedValueOnce({
      code: 'messaging/invalid-registration-token',
      message: 'Token invalid',
    });
    userUpdateMock.mockResolvedValueOnce(undefined);

    await runUpdate({ status: 'submitted' }, { status: 'resolved' });

    expect(userUpdateMock).toHaveBeenCalledTimes(1);
    expect(userUpdateMock).toHaveBeenCalledWith({
      fcmToken: deleteSentinel,
    });
  });

  it('keeps a token the user replaced while the send was in flight', async () => {
    userGetMock.mockResolvedValueOnce({
      exists: true,
      data: () => ({ fcmToken: 'stale-tok' }),
    });
    sendMock.mockRejectedValueOnce({
      code: 'messaging/registration-token-not-registered',
      message: 'Token unregistered',
    });
    txGetMock.mockResolvedValueOnce({ exists: true, get: () => 'fresh-tok' });

    await runUpdate({ status: 'submitted' }, { status: 'under_review' });

    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it('rethrows unexpected error and does not remove token', async () => {
    userGetMock.mockResolvedValueOnce({
      exists: true,
      data: () => ({ fcmToken: 'valid-token' }),
    });
    const serverError = {
      code: 'messaging/server-unavailable',
      message: 'Server down',
    };
    sendMock.mockRejectedValueOnce(serverError);

    await expect(runUpdate({ status: 'submitted' }, { status: 'under_review' })).rejects.toEqual(
      serverError,
    );
    expect(userUpdateMock).not.toHaveBeenCalled();
  });

  it('rethrows generic non-firebase error', async () => {
    userGetMock.mockResolvedValueOnce({
      exists: true,
      data: () => ({ fcmToken: 'valid-token' }),
    });
    const genericError = new Error('Unexpected crash');
    sendMock.mockRejectedValueOnce(genericError);

    await expect(runUpdate({ status: 'submitted' }, { status: 'under_review' })).rejects.toThrow(
      'Unexpected crash',
    );
    expect(userUpdateMock).not.toHaveBeenCalled();
  });
});
