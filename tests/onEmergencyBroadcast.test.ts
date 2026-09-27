import functionsTest from 'firebase-functions-test';

import type { EmergencyBroadcast } from '../src/types';

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

import { onEmergencyBroadcast } from '../src/notifications/onEmergencyBroadcast';

// --- Fixtures & Helpers --------------------------------------------------------

const BASE_BROADCAST: Omit<EmergencyBroadcast, 'createdAt'> = {
  id: 'b-1',
  title: 'Severe Cyclone Warning',
  message: 'Heavy winds expected along the coast. Seek immediate shelter.',
  city: 'Mumbai',
  severity: 'critical',
  createdBy: 'admin-1',
};

function runCreated(
  broadcastData: Partial<Omit<EmergencyBroadcast, 'createdAt'>> | null,
  broadcastId = 'b-1',
): Promise<void> {
  const snap =
    broadcastData !== null
      ? testEnv.firestore.makeDocumentSnapshot(
          { ...BASE_BROADCAST, ...broadcastData },
          `emergencyBroadcasts/${broadcastId}`,
        )
      : testEnv.firestore.makeDocumentSnapshot({}, `emergencyBroadcasts/${broadcastId}`);

  const wrapped = testEnv.wrap(onEmergencyBroadcast);
  return wrapped({ data: snap, params: { broadcastId } } as never);
}

afterAll(() => {
  testEnv.cleanup();
});

// --- Tests ---------------------------------------------------------------------

describe('onEmergencyBroadcast', () => {
  it('does nothing when event carried no data', async () => {
    const wrapped = testEnv.wrap(onEmergencyBroadcast);
    await wrapped({ data: undefined, params: { broadcastId: 'b-1' } } as never);

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does nothing when document snapshot data is empty', async () => {
    await runCreated(null);

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sends to default topic "emergency_alerts" when city is undefined or empty', async () => {
    sendMock.mockResolvedValueOnce('msg-em-1');

    await runCreated({ city: '' });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'emergency_alerts',
      }),
    );
  });

  it('sends to default topic "emergency_alerts" when city is whitespace only', async () => {
    sendMock.mockResolvedValueOnce('msg-em-space');

    await runCreated({ city: '   ' });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'emergency_alerts',
      }),
    );
  });

  it('sends to default topic "emergency_alerts" when city is "all" (case-insensitive)', async () => {
    sendMock.mockResolvedValueOnce('msg-em-all-1');
    await runCreated({ city: 'all' });

    sendMock.mockResolvedValueOnce('msg-em-all-2');
    await runCreated({ city: 'ALL' });

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        topic: 'emergency_alerts',
      }),
    );
    expect(sendMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        topic: 'emergency_alerts',
      }),
    );
  });

  it('sends to specific city topic when city is provided', async () => {
    sendMock.mockResolvedValueOnce('msg-em-city');

    await runCreated({ city: 'Pune' });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'Pune',
      }),
    );
  });

  it('sanitizes city topic name by replacing spaces with underscores', async () => {
    sendMock.mockResolvedValueOnce('msg-em-spaces');

    await runCreated({ city: 'New Delhi' });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'New_Delhi',
      }),
    );
  });

  it.each([
    ['Bengaluru (Bangalore)', 'Bengaluru_Bangalore'],
    ['Thiruvananthapuram, KL', 'Thiruvananthapuram_KL'],
  ])('strips characters FCM topics do not allow (%s)', async (city, topic) => {
    sendMock.mockResolvedValueOnce('msg-em-sanitized');

    await runCreated({ city });

    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ topic }));
  });

  it('falls back to "emergency_alerts" when city has no topic-safe characters', async () => {
    sendMock.mockResolvedValueOnce('msg-em-fallback');

    await runCreated({ city: 'मुंबई' });

    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ topic: 'emergency_alerts' }));
  });

  it('dispatches correct alert payload with max priority on android', async () => {
    sendMock.mockResolvedValueOnce('msg-em-full');

    await runCreated({
      title: 'Flash Flood Alert',
      message: 'Water levels rising rapidly in low-lying sectors.',
      city: 'Bengaluru',
      severity: 'high',
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith({
      topic: 'Bengaluru',
      notification: {
        title: '🚨 Emergency Alert: Flash Flood Alert',
        body: 'Water levels rising rapidly in low-lying sectors.',
      },
      data: {
        type: 'emergency_broadcast',
        broadcastId: 'b-1',
        title: 'Flash Flood Alert',
        severity: 'high',
        city: 'Bengaluru',
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'emergency_alerts',
          priority: 'max',
        },
      },
    });
  });

  it('rethrows error when messaging.send fails', async () => {
    const error = new Error('Messaging quota exceeded');
    sendMock.mockRejectedValueOnce(error);

    await expect(runCreated({ city: 'Mumbai' })).rejects.toThrow('Messaging quota exceeded');
  });
});
