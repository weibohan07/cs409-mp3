'use strict';

// Contract tests are based on README.md and FAQ.md, not the implementation.
// Each run uses a disposable MongoDB replica set, so transactions are real and
// no MONGODB_URI or external database is read, wiped, or reused.
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const app = require('../../app');
const User = require('../../models/user');
const Task = require('../../models/task');

const deadline = '2026-12-15T18:00:00.000Z';
const missingId = () => new mongoose.Types.ObjectId().toString();
let database;
let server;
let baseUrl;
let sequence = 0;

function query(params) {
  return '?' + new URLSearchParams(Object.entries(params).map(([key, value]) => [
    key, typeof value === 'string' ? value : JSON.stringify(value),
  ])).toString();
}

async function request(method, path, body, expectedStatus = 200, options = {}) {
  const init = { method, signal: AbortSignal.timeout(15_000), headers: options.headers || {} };
  if (body !== undefined) {
    if (options.raw) init.body = body;
    else {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }
  const response = await fetch(baseUrl + path, init);
  const raw = await response.text();
  assert.equal(response.status, expectedStatus, `${method} ${path}: ${raw}`);
  if (expectedStatus === 204) {
    assert.equal(raw, '');
    return { response, body: null };
  }
  assert.match(response.headers.get('content-type') || '', /application\/json/);
  let data;
  assert.doesNotThrow(() => { data = JSON.parse(raw); }, `${method} ${path} returned invalid JSON`);
  assert.equal(typeof data.message, 'string');
  assert.ok(data.message.trim().length > 0, 'message must be human readable');
  assert.ok(Object.hasOwn(data, 'data'), 'JSON response must include data');
  if (expectedStatus >= 400) {
    assert.doesNotMatch(raw, /CastError|ValidationError|MongoServerError|E11000|secret_fault_token|"stack"/);
  }
  return { response, body: data };
}

async function user(name = 'Ada', extra = {}) {
  const result = await request('POST', '/api/users', {
    name, email: `person-${++sequence}@example.edu`, ...extra,
  }, 201);
  return result.body.data;
}

async function task(name = 'Read the assignment', extra = {}) {
  const result = await request('POST', '/api/tasks', { name, deadline, ...extra }, 201);
  return result.body.data;
}

async function get(kind, id, params) {
  return (await request('GET', `/api/${kind}/${id}${params ? query(params) : ''}`)).body.data;
}

async function snapshot() {
  // Read raw documents so rollback assertions also cover hidden version fields.
  const users = await User.collection.find({}).sort({ _id: 1 }).toArray();
  const tasks = await Task.collection.find({}).sort({ _id: 1 }).toArray();
  return JSON.parse(JSON.stringify({ users, tasks }));
}

async function rejectedWithoutChanges(method, path, body, status, options) {
  const beforeState = await snapshot();
  const result = await request(method, path, body, status, options);
  assert.deepEqual(await snapshot(), beforeState, 'failed request must not change any document');
  return result;
}

async function assertReferences() {
  const state = await snapshot();
  const byUser = new Map(state.users.map(value => [value._id, value]));
  const byTask = new Map(state.tasks.map(value => [value._id, value]));
  for (const value of state.users) {
    assert.equal(new Set(value.pendingTasks).size, value.pendingTasks.length, 'pendingTasks contains duplicates');
    for (const id of value.pendingTasks) {
      const linked = byTask.get(id);
      assert.ok(linked, 'user refers to a missing task');
      assert.equal(linked.completed, false, 'completed task is in pendingTasks');
      assert.equal(linked.assignedUser, value._id);
      assert.equal(linked.assignedUserName, value.name);
    }
  }
  for (const value of state.tasks) {
    if (value.assignedUser === '') {
      assert.equal(value.assignedUserName, 'unassigned');
      continue;
    }
    const linked = byUser.get(value.assignedUser);
    assert.ok(linked, 'task refers to a missing user');
    assert.equal(value.assignedUserName, linked.name, 'task name is stale after user rename');
    assert.equal(linked.pendingTasks.includes(value._id), !value.completed);
  }
}

describe('MP3 HTTP API with a real transactional MongoDB', { concurrency: false }, () => {
  before(async () => {
    try {
      database = await MongoMemoryReplSet.create({
        binary: { version: process.env.MONGOMS_VERSION || '8.2.6' },
        replSet: {
          count: 1,
          storageEngine: 'wiredTiger',
          // TCP works in restricted environments without requiring Unix sockets.
          args: process.platform === 'win32' ? [] : ['--nounixsocket'],
        },
      });
      await mongoose.connect(database.getUri(), { dbName: 'mp3_contract_tests' });
      await User.init();
      await Task.init();
      server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      baseUrl = `http://127.0.0.1:${server.address().port}`;
    } catch (error) {
      throw new Error('Integration setup failed. A downloadable/cached mongod binary and local TCP binding are required. Tests are not skipped; see test/README.md.', { cause: error });
    }
  }, { timeout: 180_000 });

  beforeEach(async () => {
    await Task.deleteMany({});
    await User.deleteMany({});
  });

  afterEach(async () => {
    if (mongoose.connection.readyState === 1) await assertReferences();
  });

  after(async () => {
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await mongoose.disconnect();
    if (database) await database.stop();
  });

  it('offers JSON health, JSON unknown-route errors, and CORS preflight', async () => {
    await request('GET', '/');
    await request('GET', '/api');
    await request('GET', '/api/does-not-exist', undefined, 404);
    const preflight = await request('OPTIONS', '/api/tasks', undefined, 204, {
      headers: { Origin: 'https://example.edu', 'Access-Control-Request-Method': 'PUT' },
    });
    assert.ok(preflight.response.headers.get('access-control-allow-origin'));
    assert.match(preflight.response.headers.get('access-control-allow-methods') || '', /PUT/);
  });

  it('creates and retrieves a user with an empty pending list and server-owned dateCreated', async () => {
    const started = Date.now();
    const created = await user('Ada', { dateCreated: '1900-01-01T00:00:00.000Z' });
    assert.match(created._id, /^[a-f\d]{24}$/);
    assert.deepEqual(created.pendingTasks, []);
    assert.ok(Date.parse(created.dateCreated) >= started - 1000);
    assert.ok(Date.parse(created.dateCreated) <= Date.now() + 1000);
    assert.deepEqual(await get('users', created._id), created);
  });

  it('creates and retrieves a task with defaults and a server-owned dateCreated', async () => {
    const started = Date.now();
    const created = await task('Plan MP3', { dateCreated: '1900-01-01T00:00:00.000Z' });
    assert.equal(created.deadline, deadline);
    assert.equal(created.description, '');
    assert.equal(created.completed, false);
    assert.equal(created.assignedUser, '');
    assert.equal(created.assignedUserName, 'unassigned');
    assert.ok(Date.parse(created.dateCreated) >= started - 1000);
    assert.ok(Date.parse(created.dateCreated) <= Date.now() + 1000);
    assert.deepEqual(await get('tasks', created._id), created);
  });

  it('replaces a user, resets omitted pendingTasks, and preserves id/dateCreated', async () => {
    const owner = await user('Old name');
    const pending = await task('Pending', { assignedUser: owner._id });
    const done = await task('Completed', { assignedUser: owner._id, completed: true });
    const changed = (await request('PUT', `/api/users/${owner._id}`, {
      name: 'New name', email: owner.email, dateCreated: '1900-01-01',
    })).body.data;
    assert.equal(changed._id, owner._id);
    assert.equal(changed.dateCreated, owner.dateCreated);
    assert.deepEqual(changed.pendingTasks, []);
    assert.equal((await get('tasks', pending._id)).assignedUser, '');
    const stillDone = await get('tasks', done._id);
    assert.equal(stillDone.assignedUser, owner._id);
    assert.equal(stillDone.assignedUserName, 'New name');
  });

  it('replaces a task, resets omitted optional fields, and preserves id/dateCreated', async () => {
    const owner = await user();
    const initial = await task('Initial', { description: 'Old description', completed: true, assignedUser: owner._id });
    const changed = (await request('PUT', `/api/tasks/${initial._id}`, {
      name: 'Replacement', deadline: '2027-01-01', dateCreated: '1900-01-01',
    })).body.data;
    assert.equal(changed._id, initial._id);
    assert.equal(changed.dateCreated, initial.dateCreated);
    assert.equal(changed.name, 'Replacement');
    assert.equal(changed.deadline, '2027-01-01T00:00:00.000Z');
    assert.equal(changed.description, '');
    assert.equal(changed.completed, false);
    assert.equal(changed.assignedUser, '');
    assert.equal(changed.assignedUserName, 'unassigned');
    assert.deepEqual((await get('users', owner._id)).pendingTasks, []);
  });

  it('supports a compound where/sort/select/skip/limit query for users', async () => {
    await user('Celia');
    const b = await user('Bianca');
    await user('Ada');
    await user('Outside');
    const result = await request('GET', '/api/users' + query({
      where: { $or: [{ name: 'Celia' }, { name: 'Bianca' }, { name: 'Ada' }] },
      sort: { name: 1 }, select: { name: 1, email: 1, _id: 0 }, skip: 1, limit: 1,
    }));
    assert.deepEqual(result.body.data, [{ name: 'Bianca', email: b.email }]);
  });

  it('supports task ObjectId $in, completion filters, dates, sort, and pagination together', async () => {
    const a = await task('A', { deadline: '2026-12-01' });
    const b = await task('B', { deadline: '2026-12-03' });
    const c = await task('C', { deadline: '2026-12-05', completed: true });
    await task('D', { deadline: '2027-01-01' });
    const result = await request('GET', '/api/tasks' + query({
      where: { _id: { $in: [a._id, b._id, c._id] }, completed: false, deadline: { $gte: '2026-12-01' } },
      sort: { deadline: -1 }, select: { name: 1, _id: 0 }, skip: 1, limit: 1,
    }));
    assert.deepEqual(result.body.data, [{ name: 'A' }]);
  });

  it('counts all matching documents before pagination and supports count=false', async () => {
    await task('One');
    await task('Two');
    await task('Done', { completed: true });
    const count = await request('GET', '/api/tasks' + query({
      where: { completed: false }, sort: { name: 1 }, select: { name: 1 }, skip: 1, limit: 1, count: true,
    }));
    assert.equal(count.body.data, 2);
    const list = await request('GET', '/api/tasks' + query({ count: false }));
    assert.equal(list.body.data.length, 3);
  });

  it('defaults to 100 tasks and unlimited users; explicit limit=0 is unlimited', async () => {
    await Task.insertMany(Array.from({ length: 107 }, (_, n) => ({ name: `Task ${n}`, deadline })));
    await User.insertMany(Array.from({ length: 105 }, (_, n) => ({ name: `User ${n}`, email: `bulk-${n}@example.edu` })));
    assert.equal((await request('GET', '/api/tasks')).body.data.length, 100);
    assert.equal((await request('GET', '/api/users')).body.data.length, 105);
    assert.equal((await request('GET', '/api/tasks?limit=0')).body.data.length, 107);
    assert.equal((await request('GET', '/api/tasks?count=true')).body.data, 107);
    assert.equal((await request('GET', '/api/users?skip=103')).body.data.length, 2);
  });

  it('returns 200 with [] or 0 for collection no-match queries', async () => {
    await user();
    await task();
    for (const kind of ['users', 'tasks']) {
      const where = { _id: missingId() };
      assert.deepEqual((await request('GET', `/api/${kind}` + query({ where }))).body.data, []);
      assert.equal((await request('GET', `/api/${kind}` + query({ where, count: true }))).body.data, 0);
      // Unknown filter fields must not be stripped into a query for every row.
      assert.deepEqual((await request('GET', `/api/${kind}` + query({ where: { nonexistentField: 'value' } }))).body.data, []);
    }
  });

  it('applies inclusion and exclusion projections on individual resources', async () => {
    const owner = await user();
    const work = await task();
    for (const [kind, created] of [['users', owner], ['tasks', work]]) {
      assert.deepEqual(await get(kind, created._id, { select: { name: 1, _id: 0 } }), { name: created.name });
      assert.deepEqual(await get(kind, created._id, { select: { _id: 1 } }), { _id: created._id });
      const excluded = await get(kind, created._id, { select: { _id: 0, dateCreated: 0 } });
      assert.equal(excluded._id, undefined);
      assert.equal(excluded.dateCreated, undefined);
      assert.equal(excluded.name, created.name);
    }
  });

  it('returns an existing resource even if projection removes every field', async () => {
    const owner = await user();
    const allFields = Object.fromEntries(Object.keys(owner).map(key => [key, 0]));
    assert.deepEqual(await get('users', owner._id, { select: allFields }), {});
  });

  it('ignores non-select parameters on individual resources, including malformed values', async () => {
    const owner = await user();
    const work = await task();
    for (const [kind, created] of [['users', owner], ['tasks', work]]) {
      const result = await get(kind, created._id, { where: '{bad', sort: '[]', skip: '-8', limit: 'no', count: '{' });
      assert.deepEqual(result, created);
    }
  });

  for (const [label, params] of [
    ['malformed where JSON', { where: '{' }],
    ['non-object where', { where: [] }],
    ['malformed sort JSON', { sort: '{' }],
    ['bad sort direction', { sort: { name: 7 } }],
    ['malformed select JSON', { select: '{' }],
    ['bad projection value', { select: { name: 'yes' } }],
    ['mixed inclusion/exclusion projection', { select: { name: 1, email: 0 } }],
    ['negative skip', { skip: -1 }],
    ['fractional skip', { skip: 0.5 }],
    ['negative limit', { limit: -1 }],
    ['fractional limit', { limit: 1.5 }],
    ['invalid count', { count: 'yes' }],
  ]) {
    it(`rejects ${label} with 400 on both collections`, async () => {
      await request('GET', '/api/users' + query(params), undefined, 400);
      await request('GET', '/api/tasks' + query(params), undefined, 400);
    });
  }

  it('rejects invalid query operators and regular expressions as client errors', async () => {
    await task();
    for (const where of [{ name: { $regex: '[' } }, { $unknownOperator: 1 }, { _id: 'not-an-id' }]) {
      await request('GET', '/api/tasks' + query({ where }), undefined, 400);
    }
    await request('GET', '/api/users' + query({ where: { pendingTasks: { $size: 'no' } } }), undefined, 400);
    await request('GET', '/api/tasks' + query({ count: true, limit: -1 }), undefined, 400);
  });

  it('rejects invalid single-resource select with 400', async () => {
    const owner = await user();
    const work = await task();
    await request('GET', `/api/users/${owner._id}?select=%7B`, undefined, 400);
    await request('GET', `/api/tasks/${work._id}?select=%7B`, undefined, 400);
  });

  it('uses 404 for malformed and nonexistent ids on GET, PUT, DELETE before body validation', async () => {
    for (const kind of ['users', 'tasks']) {
      for (const id of ['not-an-object-id', missingId()]) {
        await request('GET', `/api/${kind}/${id}`, undefined, 404);
        await rejectedWithoutChanges('PUT', `/api/${kind}/${id}`, {}, 404);
        await rejectedWithoutChanges('DELETE', `/api/${kind}/${id}`, undefined, 404);
      }
    }
  });

  it('requires user name/email with correct JSON types for POST and PUT', async () => {
    const owner = await user();
    for (const body of [{}, { name: 'A' }, { email: 'a@example.edu' }, { name: 2, email: 'a@example.edu' }, { name: 'A', email: false }, { name: '', email: 'a@example.edu' }]) {
      await rejectedWithoutChanges('POST', '/api/users', body, 400);
      await rejectedWithoutChanges('PUT', `/api/users/${owner._id}`, body, 400);
    }
  });

  it('requires task name/deadline and rejects invalid optional JSON types for POST and PUT', async () => {
    const work = await task();
    const valid = { name: 'Valid', deadline };
    for (const body of [{}, { name: 'A' }, { deadline }, { name: 2, deadline }, { name: 'A', deadline: 'invalid-date' }, { ...valid, completed: 'false' }, { ...valid, description: {} }, { ...valid, assignedUser: 42 }, { ...valid, assignedUserName: [] }]) {
      await rejectedWithoutChanges('POST', '/api/tasks', body, 400);
      await rejectedWithoutChanges('PUT', `/api/tasks/${work._id}`, body, 400);
    }
  });

  it('enforces unique user email while permitting a user to keep their own address', async () => {
    const a = await user('A');
    const b = await user('B');
    await rejectedWithoutChanges('POST', '/api/users', { name: 'Duplicate', email: a.email }, 400);
    await rejectedWithoutChanges('PUT', `/api/users/${b._id}`, { name: 'Duplicate', email: a.email }, 400);
    const kept = (await request('PUT', `/api/users/${a._id}`, { name: 'Renamed', email: a.email })).body.data;
    assert.equal(kept.email, a.email);
  });

  it('rejects malformed pending task ids and non-array pendingTasks with 400', async () => {
    const owner = await user();
    for (const pendingTasks of ['a string', {}, ['bad-id'], [42], [null]]) {
      const body = { name: 'A', email: 'a@example.edu', pendingTasks };
      await rejectedWithoutChanges('POST', '/api/users', body, 400);
      await rejectedWithoutChanges('PUT', `/api/users/${owner._id}`, body, 400);
    }
  });

  it('distinguishes malformed reference ids (400) from well-formed missing references (404)', async () => {
    const owner = await user();
    const work = await task();
    for (const [ref, status] of [['invalid-id', 400], [missingId(), 404]]) {
      await rejectedWithoutChanges('POST', '/api/users', { name: 'A', email: 'a@example.edu', pendingTasks: [ref] }, status);
      await rejectedWithoutChanges('PUT', `/api/users/${owner._id}`, { name: 'A', email: owner.email, pendingTasks: [ref] }, status);
      await rejectedWithoutChanges('POST', '/api/tasks', { name: 'A', deadline, assignedUser: ref }, status);
      await rejectedWithoutChanges('PUT', `/api/tasks/${work._id}`, { name: 'A', deadline, assignedUser: ref }, status);
    }
  });

  it('rejects completed tasks in pendingTasks without changing any relationship', async () => {
    const owner = await user();
    const done = await task('Done', { assignedUser: owner._id, completed: true });
    const pending = await task('Pending', { assignedUser: owner._id });
    await rejectedWithoutChanges('POST', '/api/users', { name: 'New', email: 'new@example.edu', pendingTasks: [pending._id, done._id] }, 400);
    await rejectedWithoutChanges('PUT', `/api/users/${owner._id}`, { name: 'Changed', email: owner.email, pendingTasks: [done._id] }, 400);
  });

  it('rejects mismatched assignedUserName with 400 and fills it when omitted', async () => {
    const owner = await user('Actual name');
    const work = await task('Work', { assignedUser: owner._id });
    assert.equal(work.assignedUserName, owner.name);
    await rejectedWithoutChanges('POST', '/api/tasks', { name: 'Bad', deadline, assignedUser: owner._id, assignedUserName: 'Wrong' }, 400);
    await rejectedWithoutChanges('PUT', `/api/tasks/${work._id}`, { name: 'Bad', deadline, assignedUser: owner._id, assignedUserName: 'Wrong' }, 400);
    const unassigned = await task('Unassigned', { assignedUser: '', assignedUserName: owner.name });
    assert.equal(unassigned.assignedUserName, 'unassigned');
  });

  it('validates all referenced tasks before modifying existing assignments', async () => {
    const owner = await user('Original');
    const a = await task('A', { assignedUser: owner._id });
    const target = await user('Target');
    await rejectedWithoutChanges('PUT', `/api/users/${target._id}`, {
      name: 'Target changed', email: target.email, pendingTasks: [a._id, missingId()],
    }, 404);
    await rejectedWithoutChanges('POST', '/api/users', {
      name: 'New', email: 'new@example.edu', pendingTasks: [a._id, missingId()],
    }, 404);
  });

  it('gives duplicate email 400 priority over a well-formed nonexistent pending task', async () => {
    const a = await user('A');
    const b = await user('B');
    await rejectedWithoutChanges('PUT', `/api/users/${b._id}`, {
      name: 'B', email: a.email, pendingTasks: [missingId()],
    }, 400);
  });

  it('keeps two-way references through assignment, reassignment, completion, reopening, and unassignment', async () => {
    const a = await user('A');
    const b = await user('B');
    const work = await task('Work', { assignedUser: a._id });
    assert.deepEqual((await get('users', a._id)).pendingTasks, [work._id]);
    await request('PUT', `/api/tasks/${work._id}`, { name: 'Work', deadline, assignedUser: b._id });
    assert.deepEqual((await get('users', a._id)).pendingTasks, []);
    assert.deepEqual((await get('users', b._id)).pendingTasks, [work._id]);
    await request('PUT', `/api/tasks/${work._id}`, { name: 'Work', deadline, assignedUser: b._id, completed: true });
    assert.deepEqual((await get('users', b._id)).pendingTasks, []);
    assert.equal((await get('tasks', work._id)).assignedUser, b._id);
    await request('PUT', `/api/tasks/${work._id}`, { name: 'Work', deadline, assignedUser: a._id, completed: true });
    assert.deepEqual((await get('users', a._id)).pendingTasks, []);
    await request('PUT', `/api/tasks/${work._id}`, { name: 'Work', deadline, assignedUser: a._id, completed: false });
    assert.deepEqual((await get('users', a._id)).pendingTasks, [work._id]);
    await request('PUT', `/api/tasks/${work._id}`, { name: 'Work', deadline, assignedUser: '' });
    assert.deepEqual((await get('users', a._id)).pendingTasks, []);
    assert.equal((await get('tasks', work._id)).assignedUserName, 'unassigned');
  });

  it('POST /users can claim existing tasks and move tasks from a previous owner', async () => {
    const a = await user('A');
    const assigned = await task('Assigned', { assignedUser: a._id });
    const free = await task('Free');
    const b = await user('B', { pendingTasks: [assigned._id, free._id] });
    assert.deepEqual(new Set(b.pendingTasks), new Set([assigned._id, free._id]));
    assert.deepEqual((await get('users', a._id)).pendingTasks, []);
    for (const work of [assigned, free]) assert.equal((await get('tasks', work._id)).assignedUser, b._id);
  });

  it('PUT /users unassigns removed tasks, moves added tasks, retains others, and renames completed tasks', async () => {
    const a = await user('A');
    const b = await user('B');
    const removed = await task('Removed', { assignedUser: a._id });
    const retained = await task('Retained', { assignedUser: a._id });
    const done = await task('Done', { assignedUser: a._id, completed: true });
    const moved = await task('Moved', { assignedUser: b._id });
    const free = await task('Free');
    const changed = (await request('PUT', `/api/users/${a._id}`, {
      name: 'Renamed A', email: a.email, pendingTasks: [retained._id, moved._id, free._id],
    })).body.data;
    assert.deepEqual(new Set(changed.pendingTasks), new Set([retained._id, moved._id, free._id]));
    assert.equal((await get('tasks', removed._id)).assignedUser, '');
    assert.deepEqual((await get('users', b._id)).pendingTasks, []);
    for (const work of [retained, moved, free, done]) {
      const current = await get('tasks', work._id);
      assert.equal(current.assignedUser, a._id);
      assert.equal(current.assignedUserName, 'Renamed A');
    }
  });

  it('DELETE /tasks removes references, including completed and unassigned task cases', async () => {
    const owner = await user();
    for (const props of [{ assignedUser: owner._id }, { assignedUser: owner._id, completed: true }, {}]) {
      const work = await task('Delete me', props);
      await request('DELETE', `/api/tasks/${work._id}`, undefined, 204);
      await request('GET', `/api/tasks/${work._id}`, undefined, 404);
      assert.deepEqual((await get('users', owner._id)).pendingTasks, []);
      await request('DELETE', `/api/tasks/${work._id}`, undefined, 404);
    }
  });

  it('DELETE /users keeps and unassigns all of its tasks, including completed tasks', async () => {
    const owner = await user();
    const pending = await task('Pending', { assignedUser: owner._id });
    const done = await task('Done', { assignedUser: owner._id, completed: true });
    const other = await user('Other');
    const unrelated = await task('Unrelated', { assignedUser: other._id });
    await request('DELETE', `/api/users/${owner._id}`, undefined, 204);
    await request('GET', `/api/users/${owner._id}`, undefined, 404);
    for (const work of [pending, done]) {
      const current = await get('tasks', work._id);
      assert.equal(current.assignedUser, '');
      assert.equal(current.assignedUserName, 'unassigned');
      assert.equal(current.completed, work.completed);
    }
    assert.equal((await get('tasks', unrelated._id)).assignedUser, other._id);
  });

  it('supports URLencoded form bodies with booleans and pendingTasks arrays', async () => {
    const form = { raw: true, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } };
    const owner = (await request('POST', '/api/users', new URLSearchParams({ name: 'Form owner', email: 'form@example.edu' }).toString(), 201, form)).body.data;
    const work = (await request('POST', '/api/tasks', new URLSearchParams({ name: 'Form task', deadline, completed: 'false', assignedUser: owner._id }).toString(), 201, form)).body.data;
    assert.equal(work.completed, false);
    assert.deepEqual((await get('users', owner._id)).pendingTasks, [work._id]);
    const changed = (await request('PUT', `/api/users/${owner._id}`, new URLSearchParams({ name: 'Renamed form owner', email: owner.email, pendingTasks: JSON.stringify([work._id]) }).toString(), 200, form)).body.data;
    assert.deepEqual(changed.pendingTasks, [work._id]);
    assert.equal((await get('tasks', work._id)).assignedUserName, changed.name);
  });

  it('rejects invalid JSON and array request bodies with a readable 400', async () => {
    await rejectedWithoutChanges('POST', '/api/users', '{invalid', 400, { raw: true, headers: { 'Content-Type': 'application/json' } });
    await rejectedWithoutChanges('POST', '/api/users', [], 400);
    await rejectedWithoutChanges('POST', '/api/tasks', [], 400);
  });

  it('rolls back task creation if updating the owner fails after the task was inserted', async t => {
    const owner = await user();
    let sawInsertedTask = false;
    t.mock.method(User, 'updateOne', async function (...args) {
      const session = args[2].session;
      sawInsertedTask = Boolean(await Task.findOne({ name: 'Injected failure' }).session(session));
      throw new Error('secret_fault_token: database internals must stay private');
    });
    try {
      await rejectedWithoutChanges('POST', '/api/tasks', { name: 'Injected failure', deadline, assignedUser: owner._id }, 500);
      assert.equal(sawInsertedTask, true, 'fault must occur after a real database write');
    } finally { t.mock.restoreAll(); }
  });

  it('rolls back task replacement and old-owner cleanup after a later database failure', async t => {
    const owner = await user();
    const work = await task('Original', { assignedUser: owner._id });
    const realUpdate = Task.findByIdAndUpdate;
    let sawUpdatedTask = false;
    t.mock.method(Task, 'findByIdAndUpdate', async function (...args) {
      const result = await realUpdate.apply(this, args);
      sawUpdatedTask = result.name === 'Changed';
      throw new Error('secret_fault_token: injected after replacing task');
    });
    try {
      await rejectedWithoutChanges('PUT', `/api/tasks/${work._id}`, { name: 'Changed', deadline }, 500);
      assert.equal(sawUpdatedTask, true);
    } finally { t.mock.restoreAll(); }
  });

  it('rolls back task deletion if removing user references fails', async t => {
    const owner = await user();
    const work = await task('Original', { assignedUser: owner._id });
    let sawDeletedTask = false;
    t.mock.method(User, 'updateMany', async function (...args) {
      sawDeletedTask = (await Task.findById(work._id).session(args[2].session)) === null;
      throw new Error('secret_fault_token: injected after deleting task');
    });
    try {
      await rejectedWithoutChanges('DELETE', `/api/tasks/${work._id}`, undefined, 500);
      assert.equal(sawDeletedTask, true);
    } finally { t.mock.restoreAll(); }
  });

  for (const action of ['create', 'replace', 'delete']) {
    it(`rolls back user ${action} and relationship changes after a later database failure`, async t => {
      const owner = await user('Original');
      const work = await task('Existing work', { assignedUser: owner._id });
      const target = await user('Target');
      let sawEarlierWrite = false;
      t.mock.method(Task, 'updateMany', async function (...args) {
        const session = args[2].session;
        if (action === 'create') sawEarlierWrite = Boolean(await User.findOne({ email: 'injected@example.edu' }).session(session));
        if (action === 'replace') sawEarlierWrite = (await User.findById(target._id).session(session)).name === 'Changed';
        if (action === 'delete') sawEarlierWrite = (await User.findById(owner._id).session(session)) === null;
        throw new Error('secret_fault_token: injected after earlier user write');
      });
      try {
        if (action === 'create') await rejectedWithoutChanges('POST', '/api/users', {
          name: 'Changed', email: 'injected@example.edu', pendingTasks: [work._id],
        }, 500);
        if (action === 'replace') await rejectedWithoutChanges('PUT', `/api/users/${target._id}`, {
          name: 'Changed', email: target.email, pendingTasks: [work._id],
        }, 500);
        if (action === 'delete') await rejectedWithoutChanges('DELETE', `/api/users/${owner._id}`, undefined, 500);
        assert.equal(sawEarlierWrite, true, 'fault must occur after a real database write');
      } finally { t.mock.restoreAll(); }
    });
  }

  it('normalizes uppercase valid ids in paths and references', async () => {
    const owner = await user();
    const work = await task('Uppercase', { assignedUser: owner._id.toUpperCase() });
    assert.equal(work.assignedUser, owner._id);
    assert.equal((await get('tasks', work._id.toUpperCase()))._id, work._id);
    const changed = (await request('PUT', `/api/users/${owner._id.toUpperCase()}`, {
      name: owner.name, email: owner.email, pendingTasks: [work._id.toUpperCase()],
    })).body.data;
    assert.deepEqual(changed.pendingTasks, [work._id]);
  });
});
