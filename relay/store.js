const crypto = require('crypto');
const jobs = new Map();
// A claimed job whose worker crashed holds its lease forever unless it expires; after this long
// jobs/next may hand it to another worker. Done jobs are kept bounded so a long-lived relay does
// not grow without limit - newest results win, oldest done entries are evicted.
const CLAIM_TTL_MS = 120 * 1000;
const DONE_CAP = 500;
function createJob(body) {
  // Opaque UUID ids, not sequential integers - a guessable id lets anyone who can reach the
  // relay enumerate and read other jobs' results.
  const id = crypto.randomUUID();
  const job = {
    id, status: 'pending', result: null, error: null,
    query: body.query || null, mode: body.mode || 'search',
    kind: body.kind || (body.query ? 'query' : null),
    payload: body.payload || null
  };
  jobs.set(id, job);
  return job;
}
function take(job, now) { job.status = 'claimed'; job.claimedAt = now; return job; }
function claimNext(nowMs) {
  const now = (nowMs == null) ? Date.now() : nowMs;
  for (const job of jobs.values()) {
    if (job.status === 'pending') return take(job, now);
    if (job.status === 'claimed' && now - job.claimedAt > CLAIM_TTL_MS) {
      job.status = 'pending';
      return take(job, now);   // requeue-and-reclaim in one pass for a crashed worker's job
    }
  }
  return null;
}
function setResult(id, { result, error }) {
  const job = jobs.get(id);
  // Only the worker holding a live claim may resolve a job - otherwise pending jobs accept
  // unsolicited results and finished jobs can be overwritten.
  if (!job || job.status !== 'claimed') return null;
  if (error) { job.status = 'error'; job.error = error; }
  else { job.status = 'done'; job.result = result; }
  evictOldDone();
  return job;
}
function evictOldDone() {
  let doneCount = 0;
  for (const j of jobs.values()) if (j.status === 'done') doneCount++;
  for (const [id, j] of jobs) {
    if (doneCount <= DONE_CAP) break;
    if (j.status === 'done') { jobs.delete(id); doneCount--; }  // Map order = oldest first
  }
}
function get(id) { return jobs.get(id) || null; }
function _size() { return jobs.size; }
function _reset() { jobs.clear(); }
module.exports = { createJob, claimNext, setResult, get, _reset, _size, CLAIM_TTL_MS, DONE_CAP };
