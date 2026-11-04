'use strict';

const { ApiError } = require('./errors');

const objectIdPattern = /^[a-f\d]{24}$/i;

function parseId(value, label, status = 400) {
  if (typeof value !== 'string' || !objectIdPattern.test(value)) {
    throw new ApiError(status, status === 404 ? `${label} not found.` : `${label} must be a valid ID.`);
  }
  return value.toLowerCase();
}

function requireBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'The request body must be an object.');
  }
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiError(400, `${field} is required and must be a non-empty string.`);
  }
  return value;
}

function optionalString(value, field, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new ApiError(400, `${field} must be a string.`);
  return value;
}

function normalizeUser(body, { form = false } = {}) {
  requireBody(body);
  const name = requiredString(body.name, 'name');
  const email = requiredString(body.email, 'email');
  let pendingTasks = body.pendingTasks === undefined ? [] : body.pendingTasks;

  // Form fields are strings; JSON requests must already have the correct types.
  if (form && typeof pendingTasks === 'string') {
    try {
      pendingTasks = JSON.parse(pendingTasks);
    } catch {
      throw new ApiError(400, 'pendingTasks must contain a JSON array of task IDs.');
    }
  }
  if (!Array.isArray(pendingTasks)) {
    throw new ApiError(400, 'pendingTasks must be an array of task IDs.');
  }
  pendingTasks = [...new Set(pendingTasks.map(id => parseId(id, 'A pending task')))];

  // Only writable fields are returned. Client _id/dateCreated are ignored.
  return { name, email, pendingTasks };
}

function normalizeTask(body, { form = false } = {}) {
  requireBody(body);
  const name = requiredString(body.name, 'name');
  const description = optionalString(body.description, 'description', '');
  const rawDeadline = body.deadline;
  if (!['string', 'number'].includes(typeof rawDeadline) ||
      (typeof rawDeadline === 'string' && rawDeadline.trim() === '') ||
      (typeof rawDeadline === 'number' && !Number.isFinite(rawDeadline))) {
    throw new ApiError(400, 'deadline is required and must be a valid date.');
  }
  const deadline = new Date(rawDeadline);
  if (!Number.isFinite(deadline.getTime())) {
    throw new ApiError(400, 'deadline is required and must be a valid date.');
  }

  let completed = body.completed === undefined ? false : body.completed;
  if (form && (completed === 'true' || completed === 'false')) completed = completed === 'true';
  if (typeof completed !== 'boolean') throw new ApiError(400, 'completed must be a boolean.');

  let assignedUser = optionalString(body.assignedUser, 'assignedUser', '');
  if (assignedUser !== '') assignedUser = parseId(assignedUser, 'assignedUser');
  const suppliedName = optionalString(body.assignedUserName, 'assignedUserName', undefined);
  const assignedUserName = assignedUser === '' ? 'unassigned' : suppliedName;

  return { name, description, deadline, completed, assignedUser, assignedUserName };
}

module.exports = { parseId, normalizeUser, normalizeTask };
