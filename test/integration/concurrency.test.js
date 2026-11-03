'use strict';

// Deterministic transaction regressions for User/Task assignment races. This
// file owns an isolated, real MongoDB replica set and never reads MONGODB_URI.
const { after, before, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const app = require('../../app');
const User = require('../../models/user');
const Task = require('../../models/task');

const deadline = '2026-12-15T18:00:00.000Z';
let database;
let server;
let baseUrl;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function withTimeout(promise, message, timeoutMs = 10_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function pauseFirstTaskSaves(names) {
  const originalSave = Task.prototype.save;
  const arrivals = new Map(names.map(name => [name, deferred()]));
  const paused = new Set();
  const attempts = new Map();
  const release = deferred();

  // resolveAssignment has already read the user and filled assignedUserName
  // when a new Task reaches save(). Pause BEFORE that first task write, so a
  // second HTTP request can commit while the first transaction holds its old
  // snapshot. A transaction retry must pass through without pausing again.
  Task.prototype.save = async function (...args) {
    if (arrivals.has(this.name)) {
      attempts.set(this.name, (attempts.get(this.name) || 0) + 1);
      if (!paused.has(this.name)) {
        paused.add(this.name);
        arrivals.get(this.name).resolve({
          name: this.name,
          assignedUser: this.assignedUser,
          assignedUserName: this.assignedUserName,
        });
        await withTimeout(release.promise, `Task save barrier was not released: ${this.name}`);
      }
    }
    return originalSave.apply(this, args);
  };

  return {
    reached: () => withTimeout(
      Promise.all([...arrivals.values()].map(arrival => arrival.promise)),
      'Expected task creation did not reach its save barrier.',
    ),
    release: () => release.resolve(),
    attempts: name => attempts.get(name) || 0,
    restore() {
      release.resolve();
      Task.prototype.save = originalSave;
    },
  };
}

async function request(method, path, body) {
  const init = { method, signal: AbortSignal.timeout(20_000) };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(baseUrl + path, init);
  assert.match(response.headers.get('content-type') || '', /application\/json/);
  const payload = await response.json();
  assert.equal(typeof payload.message, 'string');
  assert.ok(Object.hasOwn(payload, 'data'));
  return { status: response.status, ...payload };
}

function startRequest(method, path, body) {
  const pending = request(method, path, body);
  // Attach a handler immediately while the test waits for the barrier. The
  // original promise is still awaited below, so a rejection still fails it.
  pending.catch(() => {});
  return pending;
}

async function createOwner() {
  const result = await request('POST', '/api/users', {
    name: 'Original owner', email: 'transaction-owner@example.edu',
  });
  assert.equal(result.status, 201, result.message);
  return result.data;
}

async function getUser(id) {
  const result = await request('GET', `/api/users/${id}`);
  assert.equal(result.status, 200, result.message);
  return result.data;
}

describe('Assignment transactions under overlapping HTTP requests', { concurrency: false }, () => {
  before(async () => {
    database = await MongoMemoryReplSet.create({
      binary: { version: process.env.MONGOMS_VERSION || '8.2.6' },
      replSet: {
        count: 1,
        storageEngine: 'wiredTiger',
        args: process.platform === 'win32' ? [] : ['--nounixsocket'],
      },
    });
    await mongoose.connect(database.getUri(), { dbName: 'mp3_concurrency_tests' });
    await User.init();
    await Task.init();
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  }, { timeout: 180_000 });

  beforeEach(async () => {
    await Task.deleteMany({});
    await User.deleteMany({});
  });

  after(async () => {
    try {
      if (server?.listening) {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    } finally {
      await mongoose.disconnect();
      if (database) await database.stop();
    }
  }, { timeout: 30_000 });

  it('rolls back a completed task when its owner is deleted after the assignment read', { timeout: 40_000 }, async () => {
    const owner = await createOwner();
    const name = 'Completed task racing owner deletion';
    const barrier = pauseFirstTaskSaves([name]);
    const pending = startRequest('POST', '/api/tasks', {
      name, deadline, completed: true, assignedUser: owner._id,
    });
    try {
      const [snapshot] = await barrier.reached();
      assert.equal(snapshot.assignedUser, owner._id);
      assert.equal(snapshot.assignedUserName, owner.name);

      const deleted = await request('DELETE', `/api/users/${owner._id}`);
      assert.equal(deleted.status, 200, deleted.message);
      assert.equal((await request('GET', `/api/users/${owner._id}`)).status, 404);
      barrier.release();

      const created = await pending;
      assert.equal(created.status, 404, created.message);
      assert.equal(await User.countDocuments({}), 0);
      assert.equal(await Task.countDocuments({}), 0, 'the aborted transaction left a task behind');
      const tasks = await request('GET', '/api/tasks');
      assert.equal(tasks.status, 200);
      assert.deepEqual(tasks.data, []);
    } finally {
      barrier.restore();
      await Promise.allSettled([pending]);
    }
  });

  it('retries a completed task creation and uses the new owner name after an overlapping rename', { timeout: 40_000 }, async () => {
    const owner = await createOwner();
    const name = 'Completed task racing owner rename';
    const newName = 'Renamed owner';
    const barrier = pauseFirstTaskSaves([name]);
    const pending = startRequest('POST', '/api/tasks', {
      // Omit assignedUserName: the server must resolve it again on retry.
      name, deadline, completed: true, assignedUser: owner._id,
    });
    try {
      const [snapshot] = await barrier.reached();
      assert.equal(snapshot.assignedUserName, owner.name, 'the first transaction did not read the old name');
      const renamed = await request('PUT', `/api/users/${owner._id}`, {
        name: newName, email: owner.email, pendingTasks: [],
      });
      assert.equal(renamed.status, 200, renamed.message);
      assert.equal(renamed.data.name, newName);
      barrier.release();

      const created = await pending;
      assert.equal(created.status, 201, created.message);
      assert.ok(barrier.attempts(name) >= 2, 'the stale transaction was not retried');
      assert.equal(created.data.assignedUser, owner._id);
      assert.equal(created.data.assignedUserName, newName);
      assert.equal(created.data.completed, true);
      const saved = await request('GET', `/api/tasks/${created.data._id}`);
      assert.equal(saved.status, 200);
      assert.equal(saved.data.assignedUserName, newName);
      assert.equal(await Task.countDocuments({}), 1, 'a retried creation left a duplicate task');
      const currentOwner = await getUser(owner._id);
      assert.equal(currentOwner.name, newName);
      assert.deepEqual(currentOwner.pendingTasks, [], 'completed task was added to pendingTasks');
    } finally {
      barrier.restore();
      await Promise.allSettled([pending]);
    }
  });

  it('keeps both pending tasks when two assignments concurrently update the same user', { timeout: 40_000 }, async () => {
    const owner = await createOwner();
    const names = ['Concurrent assignment A', 'Concurrent assignment B'];
    const barrier = pauseFirstTaskSaves(names);
    const pending = names.map(name => startRequest('POST', '/api/tasks', {
      name, deadline, assignedUser: owner._id,
    }));
    try {
      // Both requests read the same user snapshot before either may write.
      const snapshots = await barrier.reached();
      assert.ok(snapshots.every(value => value.assignedUser === owner._id));
      barrier.release();
      const results = await Promise.all(pending);
      for (const result of results) {
        assert.equal(result.status, 201, result.message);
        assert.equal(result.data.assignedUser, owner._id);
        assert.equal(result.data.assignedUserName, owner.name);
        assert.equal(result.data.completed, false);
      }
      const ids = results.map(result => result.data._id).sort();
      assert.equal(new Set(ids).size, 2);
      const currentOwner = await getUser(owner._id);
      assert.equal(currentOwner.pendingTasks.length, 2);
      assert.deepEqual([...currentOwner.pendingTasks].sort(), ids, 'one concurrent assignment was lost');
      assert.equal(await Task.countDocuments({}), 2);
      const savedTasks = await Task.find({}).lean();
      for (const task of savedTasks) {
        assert.equal(task.assignedUser, owner._id);
        assert.equal(task.assignedUserName, owner.name);
        assert.ok(currentOwner.pendingTasks.includes(task._id.toString()));
      }
    } finally {
      barrier.restore();
      await Promise.allSettled(pending);
    }
  });
});
