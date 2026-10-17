import { expect, it } from 'vitest';
import { serializeHistory } from './support/history-json.js';

it('removes nested failure traces while preserving replay data and the original history', () => {
  const history = { events: [{ eventId: '7', activityTaskFailedEventAttributes: {
    scheduledEventId: '4', startedEventId: '5', retryState: 'RETRY_STATE_MAXIMUM_ATTEMPTS_REACHED',
    failure: { message: 'synthetic', stackTrace: 'at /private/recorder/test.ts:12:3',
      cause: { message: 'nested', stackTrace: 'at C:\\recorder\\test.ts:9:2',
        applicationFailureInfo: { type: 'Error', nonRetryable: false, details: {
          payloads: [{ metadata: { encoding: 'anNvbi9wbGFpbg==' }, data: 'eyJzdGFja1RyYWNlIjoicGF5bG9hZCJ9' }],
        } },
      },
    },
  } }] };
  const original = structuredClone(history);
  const expected = structuredClone(history);
  expected.events[0]!.activityTaskFailedEventAttributes.failure.stackTrace = '';
  expected.events[0]!.activityTaskFailedEventAttributes.failure.cause.stackTrace = '';
  expect(JSON.parse(serializeHistory(history))).toEqual(expected);
  expect(history).toEqual(original);
});

it('preserves histories without traces and serializes them reproducibly', () => {
  const history = { events: [{ eventId: '1', timerStartedEventAttributes: {
    timerId: '1', startToFireTimeout: { seconds: '1' }, workflowTaskCompletedEventId: '4',
  } }] };
  const once = serializeHistory(history);
  expect(JSON.parse(once)).toEqual(history);
  expect(serializeHistory(JSON.parse(once))).toBe(once);
  expect(once.endsWith('\n')).toBe(true);
});
