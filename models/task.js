'use strict';

const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String, default: '' },
  deadline: { type: Date, required: true },
  completed: { type: Boolean, default: false },
  assignedUser: { type: String, default: '' },
  assignedUserName: { type: String, default: 'unassigned' },
  dateCreated: { type: Date, default: Date.now, immutable: true },
  __v: { type: Number, select: false }
}, {
  strictQuery: false,
  toJSON: { versionKey: false },
  toObject: { versionKey: false }
});

taskSchema.index({ assignedUser: 1, completed: 1 });

module.exports = mongoose.model('Task', taskSchema);
