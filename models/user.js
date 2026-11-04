'use strict';

const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  pendingTasks: { type: [String], default: [] },
  dateCreated: { type: Date, default: Date.now, immutable: true },
  // Touch this existing Mongoose version field when a task uses this user.
  // It makes concurrent assignment, rename, and deletion conflict and retry.
  __v: { type: Number, select: false }
}, {
  strictQuery: false,
  toJSON: { versionKey: false },
  toObject: { versionKey: false }
});

module.exports = mongoose.model('User', userSchema);
