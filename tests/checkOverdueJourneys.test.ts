import * as admin from 'firebase-admin';

// --- Mock the Firebase Admin SDK wrapper ---------------------------------------

const batchUpdateMock = jest.fn();
const batchSetMock = jest.fn();
const batchCommitMock = jest.fn(() => Promise.resolve());
const batchMock = {
  update: batchUpdateMock,
  set: batchSetMock,
  commit: batchCommitMock,
};

const sendMock = jest.fn(() => Promise.resolve('msg-123'));
const userGetMock = jest.fn();
const userDocMock = jest.fn(() => ({
  get: userGetMock,
}));

const queryGetMock = jest.fn();
const queryWhereMock2 = jest.fn(() => ({
  get: queryGetMock,
}));
const queryWhereMock1 = jest.fn(() => ({
  where: queryWhereMock2,
}));

const alertLogDocMock = jest.fn(() => ({ id: 'log-1' }));

const collectionMock = jest.fn((collName: string) => {
  if (collName === 'safeJourneySessions') {
    return {
      where: queryWhereMock1,
    };
  }
  if (collName === 'alertLogs') {
    return {
      doc: alertLogDocMock,
    };
  }
  if (collName === 'users') {
    return {
      doc: userDocMock,
    };
  }
  return {};
});

const serverTimestampMock = { __serverTimestamp__: true };

jest.mock('../src/utils/firebase', () => ({
  db: {
    collection: (coll: string) => collectionMock(coll),
    batch: () => batchMock,
  },
  messaging: {
    send: sendMock,
  },
  FieldValue: {
    serverTimestamp: () => serverTimestampMock,
  },
}));

import {
  ALERT_LOGS_COLLECTION,
  checkOverdueJourneys,
  SESSIONS_COLLECTION,
} from '../src/safety/checkOverdueJourneys';

describe('checkOverdueJourneys watchdog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does nothing when no active overdue sessions exist', async () => {
    queryGetMock.mockResolvedValueOnce({
      empty: true,
      docs: [],
    });

    await checkOverdueJourneys.run({ scheduleTime: '2026-10-15T00:00:00Z' });

    expect(collectionMock).toHaveBeenCalledWith(SESSIONS_COLLECTION);
    expect(queryWhereMock1).toHaveBeenCalledWith('status', '==', 'active');
    expect(batchCommitMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('updates overdue sessions to alert_sent, writes audit logs, and sends push notifications', async () => {
    const overdueTime = admin.firestore.Timestamp.fromDate(
      new Date(Date.now() - 5 * 60 * 1000), // 5 minutes ago
    );

    const mockDocRef = { id: 'sess-1' };
    const mockSessionDoc = {
      id: 'sess-1',
      ref: mockDocRef,
      data: () => ({
        userId: 'user-1',
        destinationName: 'Central Station',
        destinationLatitude: 18.5204,
        destinationLongitude: 73.8567,
        etaMinutes: 30,
        expectedArrivalAt: overdueTime,
        status: 'active',
      }),
    };

    queryGetMock.mockResolvedValueOnce({
      empty: false,
      docs: [mockSessionDoc],
    });

    userGetMock.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        fcmToken: 'token-user-1',
      }),
    });

    await checkOverdueJourneys.run({ scheduleTime: '2026-10-15T00:00:00Z' });

    expect(batchUpdateMock).toHaveBeenCalledWith(mockDocRef, {
      status: 'alert_sent',
      alertSentAt: serverTimestampMock,
      updatedAt: serverTimestampMock,
    });

    expect(collectionMock).toHaveBeenCalledWith(ALERT_LOGS_COLLECTION);
    expect(batchSetMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'safe_journey_overdue',
        sessionId: 'sess-1',
        userId: 'user-1',
        destinationName: 'Central Station',
      }),
    );

    expect(batchCommitMock).toHaveBeenCalledTimes(1);

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'token-user-1',
        notification: expect.objectContaining({
          title: expect.stringContaining('Safe Journey Overdue Alert'),
          body: expect.stringContaining('Central Station'),
        }),
      }),
    );
  });

  it('handles traveler without an FCM token gracefully', async () => {
    const overdueTime = admin.firestore.Timestamp.fromDate(new Date(Date.now() - 1000));

    const mockDocRef = { id: 'sess-2' };
    const mockSessionDoc = {
      id: 'sess-2',
      ref: mockDocRef,
      data: () => ({
        userId: 'user-no-token',
        destinationName: 'Home',
        expectedArrivalAt: overdueTime,
        status: 'active',
      }),
    };

    queryGetMock.mockResolvedValueOnce({
      empty: false,
      docs: [mockSessionDoc],
    });

    userGetMock.mockResolvedValueOnce({
      exists: true,
      data: () => ({}),
    });

    await checkOverdueJourneys.run({ scheduleTime: '2026-10-15T00:00:00Z' });

    expect(batchUpdateMock).toHaveBeenCalledWith(
      mockDocRef,
      expect.objectContaining({
        status: 'alert_sent',
      }),
    );
    expect(batchCommitMock).toHaveBeenCalledTimes(1);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('throws and logs when the query fails', async () => {
    queryGetMock.mockRejectedValueOnce(new Error('Firestore connection lost'));

    await expect(
      checkOverdueJourneys.run({ scheduleTime: '2026-10-15T00:00:00Z' }),
    ).rejects.toThrow('Firestore connection lost');
  });
});
