'use strict';

require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const app = require('./app');
const User = require('./models/user');
const Task = require('./models/task');

async function start() {
  const uri = process.env.MONGODB_URI;
  if (!uri || !/^mongodb(?:\+srv)?:\/\//.test(uri)) {
    throw new Error('Set MONGODB_URI to a MongoDB connection string before starting the server.');
  }
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT must be an integer between 0 and 65535.');
  }

  // Do not accept requests until the database and unique email index are ready.
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  await Promise.all([User.init(), Task.init()]);
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, '0.0.0.0', () => resolve(listener));
    listener.once('error', reject);
  });
  console.log(`Task management API listening on port ${server.address().port}.`);

  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    console.log('Shutting down the API.');
    const timeout = setTimeout(() => process.exit(1), 10000);
    timeout.unref();
    server.close(async () => {
      try {
        await mongoose.disconnect();
        clearTimeout(timeout);
        process.exitCode = 0;
      } catch {
        process.exitCode = 1;
      }
    });
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return server;
}

if (require.main === module) {
  start().catch(async () => {
    // Driver errors can contain connection details. Keep credentials out of logs.
    console.error('Server startup failed. Check MONGODB_URI, PORT, database access, and indexes.');
    await mongoose.disconnect().catch(() => {});
    process.exitCode = 1;
  });
}

module.exports = { start };
