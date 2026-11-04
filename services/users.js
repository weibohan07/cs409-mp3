'use strict';

const User = require('../models/user');
const Task = require('../models/task');
const { normalizeUser } = require('../lib/validation');
const { transact, findResource, checkEmail, checkPendingTasks } = require('./shared');

async function syncUserTasks(user, oldPendingTasks, session) {
  const userId = user._id.toString();
  const newIds = user.pendingTasks;
  const newIdSet = new Set(newIds);
  const removed = oldPendingTasks.filter(id => !newIdSet.has(id));

  if (removed.length > 0) {
    await Task.updateMany(
      { _id: { $in: removed }, assignedUser: userId },
      { $set: { assignedUser: '', assignedUserName: 'unassigned' }, $inc: { __v: 1 } },
      { session }
    );
  }
  if (newIds.length > 0) {
    await User.updateMany(
      { _id: { $ne: user._id }, pendingTasks: { $in: newIds } },
      { $pull: { pendingTasks: { $in: newIds } }, $inc: { __v: 1 } },
      { session }
    );
    await Task.updateMany(
      { _id: { $in: newIds } },
      { $set: { assignedUser: userId, assignedUserName: user.name }, $inc: { __v: 1 } },
      { session }
    );
  }
  // Completed tasks are absent from pendingTasks but still need a new name.
  await Task.updateMany(
    { assignedUser: userId, assignedUserName: { $ne: user.name } },
    { $set: { assignedUserName: user.name }, $inc: { __v: 1 } },
    { session }
  );
}

async function createUser(body, options) {
  return transact(async session => {
    const values = normalizeUser(body, options);
    await checkEmail(values.email, null, session);
    await checkPendingTasks(values.pendingTasks, session);

    const user = new User(values);
    await user.save({ session });
    await syncUserTasks(user, [], session);
    return user.toObject();
  });
}

async function replaceUser(id, body, options) {
  return transact(async session => {
    // The URL resource must be checked before validating the request body.
    const oldUser = await findResource(User, id, 'User', session);
    const values = normalizeUser(body, options);
    await checkEmail(values.email, oldUser._id, session);
    await checkPendingTasks(values.pendingTasks, session);

    // Set every writable field, while retaining _id and dateCreated.
    const user = await User.findByIdAndUpdate(oldUser._id,
      { $set: values, $inc: { __v: 1 } },
      { session, returnDocument: 'after', runValidators: true }
    );
    await syncUserTasks(user, oldUser.pendingTasks, session);
    return user.toObject();
  });
}

async function deleteUser(id) {
  return transact(async session => {
    const user = await findResource(User, id, 'User', session);
    await User.deleteOne({ _id: user._id }, { session });
    await Task.updateMany(
      { assignedUser: user._id.toString() },
      { $set: { assignedUser: '', assignedUserName: 'unassigned' }, $inc: { __v: 1 } },
      { session }
    );
    return user.toObject();
  });
}

module.exports = { createUser, replaceUser, deleteUser };
