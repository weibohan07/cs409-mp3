'use strict';

const Task = require('../models/task');
const { normalizeTask } = require('../lib/validation');
const { transact, findResource, resolveAssignment, removePendingTask, attachTask } = require('./shared');

async function createTask(body, options) {
  return transact(async session => {
    const values = normalizeTask(body, options);
    await resolveAssignment(values, session);

    const task = new Task(values);
    await task.save({ session });
    await attachTask(task, session);
    return task.toObject();
  });
}

async function replaceTask(id, body, options) {
  return transact(async session => {
    const oldTask = await findResource(Task, id, 'Task', session);
    const values = normalizeTask(body, options);
    await resolveAssignment(values, session);

    await removePendingTask(oldTask._id.toString(), session);
    const task = await Task.findByIdAndUpdate(oldTask._id,
      { $set: values, $inc: { __v: 1 } },
      { session, returnDocument: 'after', runValidators: true }
    );
    await attachTask(task, session);
    return task.toObject();
  });
}

async function deleteTask(id) {
  return transact(async session => {
    const task = await findResource(Task, id, 'Task', session);
    await Task.deleteOne({ _id: task._id }, { session });
    await removePendingTask(task._id.toString(), session);
    return task.toObject();
  });
}

module.exports = { createTask, replaceTask, deleteTask };
