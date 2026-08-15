let seq = 0;
const jobs = new Map();
function createJob(body) {
  const id = String(++seq);
  const job = {
    id, status: 'pending', result: null, error: null,
    query: body.query || null, mode: body.mode || 'search',
    kind: body.kind || (body.query ? 'query' : null),
    payload: body.payload || null
  };
  jobs.set(id, job);
  return job;
}
function claimNext() {
  for (const job of jobs.values()) {
    if (job.status === 'pending') { job.status = 'claimed'; return job; }
  }
  return null;
}
function setResult(id, { result, error }) {
  const job = jobs.get(id);
  if (!job) return null;
  if (error) { job.status = 'error'; job.error = error; }
  else { job.status = 'done'; job.result = result; }
  return job;
}
function get(id) { return jobs.get(id) || null; }
function _reset() { jobs.clear(); seq = 0; }
module.exports = { createJob, claimNext, setResult, get, _reset };
