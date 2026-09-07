import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workFeedback } from './workBar.ts';

test('generic provider fallback is shown once and preserves the failed stage', () => {
  assert.deepEqual(workFeedback({live:'done',refined:'failed',speakers:'failed',failedReason:'处理没完成',speakersFailReason:'处理没完成'}),
    [{kind:'failed',text:'录音处理未完成',retry:'refined'}]);
  assert.deepEqual(workFeedback({live:'done',refined:'done',speakers:'failed',speakersFailReason:'处理没完成'}),
    [{kind:'failed',text:'区分说话人未完成',retry:'speakers'}]);
});
const jobs = (patch = {}) => ({ live:'done', refined:'done', speakers:'done', ...patch });
test('one shared failure has one recovery action and speaker-only failure retains the refined draft', () => {
  assert.deepEqual(workFeedback(jobs({refined:'failed',speakers:'failed',failedReason:'网络不通',speakersFailReason:'网络不通'})),
    [{kind:'failed',text:'录音处理未完成：网络不通',retry:'refined'}]);
  assert.deepEqual(workFeedback(jobs({speakers:'failed',speakersFailReason:'超时'})),
    [{kind:'failed',text:'区分说话人未完成：超时',retry:'speakers'}]);
  assert.equal(workFeedback(jobs({refined:'failed',speakers:'failed',failedReason:'甲',speakersFailReason:'乙'})).length,2);
});
test('canceling is neutral and blocks retries; durable canceled status resumes only its stage', () => {
  assert.deepEqual(workFeedback(jobs({refined:'canceling',speakers:'canceling'})),[{kind:'canceling',text:'正在取消…'}]);
  assert.deepEqual(workFeedback(jobs({refined:'canceled',speakers:'canceled'})),[{kind:'canceled',text:'处理已取消',retry:'refined'}]);
  assert.deepEqual(workFeedback(jobs({speakers:'canceled'})),[{kind:'canceled',text:'说话人区分已取消',retry:'speakers'}]);
  assert.deepEqual(workFeedback(jobs()),[]);
  assert.equal(workFeedback(jobs({refined:'failed',failedReason:'已取消'}))[0].kind,'failed','legacy reasons do not invent cancellation evidence');
});
