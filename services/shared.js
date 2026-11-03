'use strict';

const mongoose = require('mongoose');
const User = require('../models/user');
const Task = require('../models/task');
const { ApiError } = require('../lib/errors');
const { parseId } = require('../lib/validation');

function transact(work) {
  return mongoose.connection.transaction(work, {
    readPreference: 'primary',
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' }
  });
}

async function findResource(Model, rawId, label, session) {
  const id = parseId(rawId, label, 404);
  const document = await Model.findById(id).session(session);
  if (!document) throw new ApiError(404, `${label} not found.`);
  return document;
}

async function checkEmail(email, ownId, session) {
  const where = { email };
  if (ownId) where._id = { $ne: ownId };
  if (await User.exists(where).session(session)) {
    throw new ApiError(400, 'This email address is already used by another user.');
  }
}

async function checkPendingTasks(ids, session) {
  if (ids.length === 0) return;
  const tasks = await Task.find({ _id: { $in: ids } }).session(session);
  if (tasks.length !== ids.length) throw new ApiError(404, 'A referenced task was not found.');
  if (tasks.some(task => task.completed)) {
    throw new ApiError(400, 'pendingTasks cannot contain completed tasks.');
  }
}

async function resolveAssignment(values, session) {
  if (values.assignedUser === '') return;
  const user = await User.findById(values.assignedUser).session(session);
  if (!user) throw new ApiError(404, 'The assigned user was not found.');
  if (values.assignedUserName !== undefined && values.assignedUserName !== user.name) {
    throw new ApiError(400, 'assignedUserName must match the assigned user\'s name.');
  }
  values.assignedUserName = user.name;
}

async function removePendingTask(taskId, session) {
  await User.updateMany(
    { pendingTasks: taskId },
    { $pull: { pendingTasks: taskId }, $inc: { __v: 1 } },
    { session }
  );
}

async function attachTask(task, session) {
  if (!task.assignedUser) return;
  const update = { $inc: { __v: 1 } };
  if (!task.completed) update.$addToSet = { pendingTasks: task._id.toString() };
  // Even a completed task touches its owner. Otherwise a concurrent user
  // deletion or rename could miss a newly inserted completed task.
  const result = await User.updateOne({ _id: task.assignedUser }, update, { session });
  if (result.matchedCount !== 1) throw new ApiError(404, 'The assigned user was not found.');
}

module.exports = {
  transact, findResource, checkEmail, checkPendingTasks,
  resolveAssignment, removePendingTask, attachTask
};
