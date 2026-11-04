'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUser, normalizeTask, parseId } = require('../../lib/validation');
const { parseCollectionQuery, parseSelect } = require('../../lib/query');
const id = '0123456789ABCDEF01234567';
const taskBody = { name: 'Plan', deadline: '2026-12-15T18:00:00.000Z' };
const is400 = error => error.status === 400 && typeof error.message === 'string';

describe('Input and query boundary contracts without a database', () => {
  it('accepts only full ObjectIds and normalizes valid uppercase ids', () => {
    assert.equal(parseId(id, 'Task'), id.toLowerCase());
    for (const input of [null, undefined, 123, {}, '123', 'z'.repeat(24)]) {
      assert.throws(() => parseId(input, 'Task'), is400);
      assert.throws(() => parseId(input, 'Task', 404), error => error.status === 404);
    }
  });

  it('preserves writable user fields while discarding client ids/dates/unknown keys', () => {
    assert.deepEqual(normalizeUser({ name: 'Ada', email: 'a@example.edu', _id: id, dateCreated: '1900-01-01', admin: true }), {
      name: 'Ada', email: 'a@example.edu', pendingTasks: [],
    });
  });

  it('normalizes task defaults without allowing a client creation timestamp', () => {
    const result = normalizeTask({ ...taskBody, _id: id, dateCreated: '1900-01-01' });
    assert.deepEqual(result, {
      name: 'Plan', deadline: new Date(taskBody.deadline), description: '',
      completed: false, assignedUser: '', assignedUserName: 'unassigned',
    });
  });

  it('deduplicates reference ids after canonicalizing their case', () => {
    assert.deepEqual(normalizeUser({ name: 'Ada', email: 'a@example.edu', pendingTasks: [id, id.toLowerCase()] }).pendingTasks, [id.toLowerCase()]);
  });

  it('rejects JSON values that only Mongoose casting would make look valid', () => {
    for (const name of [null, [], {}, 1, true, '', '   ']) assert.throws(() => normalizeUser({ name, email: 'a@example.edu' }), is400);
    for (const completed of [null, 'false', 0, [], {}]) assert.throws(() => normalizeTask({ ...taskBody, completed }), is400);
    for (const deadline of [null, undefined, '', 'garbage', true, {}, []]) assert.throws(() => normalizeTask({ ...taskBody, deadline }), is400);
    for (const pendingTasks of [null, '', '{}', {}, 1]) assert.throws(() => normalizeUser({ name: 'Ada', email: 'a@example.edu', pendingTasks }), is400);
  });

  it('normalizes form strings only when the request was URLencoded', () => {
    assert.equal(normalizeTask({ ...taskBody, completed: 'false' }, { form: true }).completed, false);
    assert.equal(normalizeTask({ ...taskBody, completed: 'true' }, { form: true }).completed, true);
    assert.deepEqual(normalizeUser({ name: 'Ada', email: 'a@example.edu', pendingTasks: JSON.stringify([id]) }, { form: true }).pendingTasks, [id.toLowerCase()]);
    assert.throws(() => normalizeTask({ ...taskBody, completed: 'not-boolean' }, { form: true }), is400);
  });

  it('normalizes unassigned task names to the specified default', () => {
    assert.equal(normalizeTask({ ...taskBody, assignedUser: '', assignedUserName: 'Stale' }).assignedUserName, 'unassigned');
  });

  it('uses documented collection defaults and permits explicit unlimited queries', () => {
    assert.deepEqual(parseCollectionQuery({}, 100), { where: {}, sort: {}, select: {}, skip: 0, limit: 100, count: false });
    assert.equal(parseCollectionQuery({ limit: '0' }, 100).limit, 0);
    assert.equal(parseCollectionQuery({}).limit, 0);
  });

  it('retains ordinary MongoDB operators and unknown field filters', () => {
    const where = { $or: [{ name: 'Ada' }, { deadline: { $gte: '2026-01-01' } }], _id: { $in: [id] }, unknownField: 'no match' };
    assert.deepEqual(parseCollectionQuery({ where: JSON.stringify(where) }).where, where);
  });

  it('allows the _id exception to projection inclusion/exclusion rules', () => {
    assert.deepEqual(parseSelect({ select: '{"name":1,"_id":0}' }), { name: 1, _id: 0 });
    assert.deepEqual(parseSelect({ select: '{"_id":1}' }), { _id: 1 });
    assert.throws(() => parseSelect({ select: '{"name":1,"email":0}' }), is400);
  });

  it('rejects malformed, repeated, and wrongly typed query parameters', () => {
    for (const raw of [
      { where: '{' }, { where: '[]' }, { where: 'null' }, { where: '{}' , limit: '1.5' },
      { skip: '-1' }, { skip: '"1"' }, { skip: '9007199254740992' },
      { sort: '{"name":0}' }, { select: '{"name":true}' },
      { count: '1' }, { count: '"true"' }, { count: ['true', 'false'] },
      { where: ['{}', '{}'] }, { limit: ['1', '2'] },
    ]) assert.throws(() => parseCollectionQuery(raw), is400);
  });

  it('validates malformed unused parameters even when count=true', () => {
    assert.throws(() => parseCollectionQuery({ count: 'true', select: '{' }), is400);
    assert.throws(() => parseCollectionQuery({ count: 'true', skip: '-1' }), is400);
  });

  it('rejects server-side code operators without removing ordinary operators', () => {
    for (const where of [{ $where: 'return true' }, { $expr: { $function: { body: 'return true', args: [], lang: 'js' } } }]) {
      assert.throws(() => parseCollectionQuery({ where: JSON.stringify(where) }), is400);
    }
  });
});
