'use strict';

const { ApiError } = require('./errors');
const { parseId } = require('./validation');

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const blockedQueryKeys = new Set(['$where', '$function', '$accumulator', '__proto__']);

function readJSON(query, parameter) {
  if (!hasOwn(query, parameter)) return undefined;
  if (typeof query[parameter] !== 'string') {
    throw new ApiError(400, `${parameter} must be supplied once as a JSON value.`);
  }
  try {
    return JSON.parse(query[parameter]);
  } catch {
    throw new ApiError(400, `${parameter} must contain valid JSON.`);
  }
}

function objectParameter(query, parameter) {
  const value = readJSON(query, parameter);
  if (value === undefined) return {};
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new ApiError(400, `${parameter} must be a JSON object.`);
  }
  return value;
}

function validateWhere(where) {
  const remaining = [where];
  while (remaining.length > 0) {
    const value = remaining.pop();
    if (value === null || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (blockedQueryKeys.has(key)) {
        throw new ApiError(400, 'where contains an unsupported query operator.');
      }
      if (key.includes('\0')) {
        throw new ApiError(400, 'where contains an invalid field name.');
      }
      remaining.push(child);
    }
  }
  return where;
}

function validateFieldName(field, parameter) {
  if (!field || field.includes('\0') || field === '__proto__' || field.startsWith('$')) {
    throw new ApiError(400, `${parameter} contains an invalid field name.`);
  }
}

function parseSelect(query) {
  const select = objectParameter(query, 'select');
  let includes = false;
  let excludes = false;
  for (const [field, direction] of Object.entries(select)) {
    validateFieldName(field, 'select');
    if (direction !== 0 && direction !== 1) {
      throw new ApiError(400, 'select values must be 1 (include) or 0 (exclude).');
    }
    if (field !== '_id') {
      includes ||= direction === 1;
      excludes ||= direction === 0;
    }
  }
  if (includes && excludes) {
    throw new ApiError(400, 'select cannot mix included and excluded fields, except for _id.');
  }
  return select;
}

function parseSort(query) {
  const sort = objectParameter(query, 'sort');
  for (const [field, direction] of Object.entries(sort)) {
    validateFieldName(field, 'sort');
    if (direction !== 1 && direction !== -1) {
      throw new ApiError(400, 'sort values must be 1 (ascending) or -1 (descending).');
    }
  }
  return sort;
}

function nonnegativeInteger(query, parameter, fallback) {
  const value = readJSON(query, parameter);
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApiError(400, `${parameter} must be a nonnegative integer.`);
  }
  return value;
}

function parseCollectionQuery(query, defaultLimit = 0) {
  // Validate every supplied parameter, including parameters unused by count.
  const where = validateWhere(objectParameter(query, 'where'));
  const sort = parseSort(query);
  const select = parseSelect(query);
  const skip = nonnegativeInteger(query, 'skip', 0);
  const limit = nonnegativeInteger(query, 'limit', defaultLimit);
  const count = readJSON(query, 'count');
  if (count !== undefined && typeof count !== 'boolean') {
    throw new ApiError(400, 'count must be true or false.');
  }
  return { where, sort, select, skip, limit, count: count === true };
}

function translateReadError(error) {
  // Query syntax/type failures are client errors. Connection failures and other
  // unexpected errors still go to the shared 500 handler without exposing them.
  const invalidQueryCodes = new Set([
    2, 9, 14, 27, 28, 52, 53, 159, 168, 17287, 16410, 16412, 16413,
    17276, 18536, 28651, 31249, 31250, 31253, 31254, 51091, 51092,
  ]);
  if (
    error.name === 'CastError' ||
    error.name === 'StrictModeError' ||
    (error.name === 'MongoServerError' && invalidQueryCodes.has(error.code)) ||
    (error.name === 'Error' && /^(Can't use |Cast to |Invalid query condition|Invalid select:|Invalid sort value:)/.test(error.message))
  ) {
    return new ApiError(400, 'The query contains an invalid field value, operator, or projection.');
  }
  return error;
}

async function listResources(Model, rawQuery, defaultLimit = 0) {
  const { where, sort, select, skip, limit, count } = parseCollectionQuery(rawQuery, defaultLimit);
  try {
    if (count) {
      // count means the total matching filter, independently of pagination.
      return await Model.countDocuments(where).setOptions({ strictQuery: false });
    }
    return await Model.find(where)
      .setOptions({ strictQuery: false })
      .sort(sort)
      .select(select)
      .skip(skip)
      .limit(limit)
      .lean();
  } catch (error) {
    throw translateReadError(error);
  }
}

async function getResource(Model, rawId, rawQuery, label) {
  const id = parseId(rawId, label, 404);
  // The assignment explicitly ignores every other parameter on /:id routes.
  const select = parseSelect(rawQuery);
  let resource;
  try {
    resource = await Model.findById(id).select(select).lean();
  } catch (error) {
    throw translateReadError(error);
  }
  // An empty projected object is still an existing resource.
  if (resource === null) throw new ApiError(404, `${label} not found.`);
  return resource;
}

module.exports = { parseSelect, parseCollectionQuery, listResources, getResource };
