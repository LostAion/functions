import functionsTest from 'firebase-functions-test';

import type { UnsafeArea } from '../src/types';

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

import { onUnsafeAreaApproved } from '../src/admin/onUnsafeAreaApproved';

// --- Fixtures & Helpers --------------------------------------------------------

const BASE_AREA: Omit<UnsafeArea, 'createdAt'> = {
  id: 'area-1',
  reportedBy: 'user-reporter',
  latitude: 18.5204,
  longitude: 73.8567,
  radiusMeters: 50,
  title: 'Dark Alley near Metro',
  description: 'Streetlights broken for the past month.',
  category: 'poorly_lit',
  status: 'pending',
  pinColor: 'orange',
  upvotes: 5,
  downvotes: 0,
  voterIds: ['u1', 'u2'],
};

/** Drops `undefined` fields so a snapshot can model a document missing them. */
function withoutUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function runUpdate(
  beforeOverrides: Partial<Omit<UnsafeArea, 'createdAt'>> | null,
  afterOverrides: Partial<Omit<UnsafeArea, 'createdAt'>> | null,
  areaId = 'area-1',
): Promise<void> {
  const beforeSnap =
    beforeOverrides !== null
      ? testEnv.firestore.makeDocumentSnapshot(
          withoutUndefined({ ...BASE_AREA, ...beforeOverrides }),
          `unsafeAreas/${areaId}`,
        )
      : testEnv.firestore.makeDocumentSnapshot({}, `unsafeAreas/${areaId}`);

  const afterSnap =
    afterOverrides !== null
      ? testEnv.firestore.makeDocumentSnapshot(
          withoutUndefined({ ...BASE_AREA, ...afterOverrides }),
          `unsafeAreas/${areaId}`,
        )
      : testEnv.firestore.makeDocumentSnapshot({}, `unsafeAreas/${areaId}`);

  const change = testEnv.makeChange(beforeSnap, afterSnap);
  const wrapped = testEnv.wrap(onUnsafeAreaApproved);
  return wrapped({ data: change, params: { areaId } } as never);
}

afterAll(() => {
  testEnv.cleanup();
});

// --- Tests ---------------------------------------------------------------------

describe('onUnsafeAreaApproved', () => {
  it('does nothing when event carried no data', async () => {
    const wrapped = testEnv.wrap(onUnsafeAreaApproved);
    await wrapped({ data: undefined, params: { areaId: 'area-1' } } as never);

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does nothing when before or after document data is empty', async () => {
    await runUpdate(null, null);

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does nothing when status remains pending', async () => {
    await runUpdate({ status: 'pending', upvotes: 5 }, { status: 'pending', upvotes: 6 });

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does nothing when status was already approved', async () => {
    await runUpdate({ status: 'approved', upvotes: 10 }, { status: 'approved', upvotes: 12 });

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('does nothing when status transitions from approved to pending', async () => {
    await runUpdate({ status: 'approved' }, { status: 'pending' });

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('broadcasts to topic "unsafe_areas" on pending -> approved transition', async () => {
    sendMock.mockResolvedValueOnce('msg-area-1');

    await runUpdate(
      { status: 'pending', category: 'poorly_lit', title: 'Dark Alley near Metro' },
      { status: 'approved', category: 'poorly_lit', title: 'Dark Alley near Metro' },
    );

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith({
      topic: 'unsafe_areas',
      notification: {
        title: '⚠️ Verified Unsafe Area Alert',
        body: 'Caution: "Dark Alley near Metro" has been verified as an unsafe area (poorly lit).',
      },
      data: {
        type: 'unsafe_area_approved',
        areaId: 'area-1',
        category: 'poorly_lit',
        latitude: '18.5204',
        longitude: '73.8567',
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'safety_alerts',
        },
      },
    });
  });

  it('correctly replaces underscores in category name in alert body', async () => {
    sendMock.mockResolvedValueOnce('msg-area-2');

    await runUpdate(
      { status: 'pending', category: 'harassment_reported', title: 'Bus Stop Backside' },
      { status: 'approved', category: 'harassment_reported', title: 'Bus Stop Backside' },
    );

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        notification: expect.objectContaining({
          body: 'Caution: "Bus Stop Backside" has been verified as an unsafe area (harassment reported).',
        }),
      }),
    );
  });

  it('rethrows error when messaging.send fails', async () => {
    const error = new Error('Topic send quota exceeded');
    sendMock.mockRejectedValueOnce(error);

    await expect(runUpdate({ status: 'pending' }, { status: 'approved' })).rejects.toThrow(
      'Topic send quota exceeded',
    );
  });

  it('falls back to "other" and blank coordinates when fields are missing', async () => {
    sendMock.mockResolvedValueOnce('msg-area-nocat');

    await runUpdate(
      { status: 'pending', category: undefined, title: 'Old Record' },
      {
        status: 'approved',
        category: undefined,
        latitude: undefined,
        longitude: undefined,
        title: 'Old Record',
      },
    );

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        notification: expect.objectContaining({
          body: 'Caution: "Old Record" has been verified as an unsafe area (other).',
        }),
        data: expect.objectContaining({ category: 'other', latitude: '', longitude: '' }),
      }),
    );
  });
});
