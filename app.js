'use strict';

const express = require('express');
const { ApiError, errorHandler } = require('./lib/errors');
const app = express();

app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, X-Requested-With, X-HTTP-Method-Override');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.use('/', require('./routes/home'));
app.use('/api', require('./routes'));

app.use((req, res, next) => next(new ApiError(404, 'Endpoint not found.')));
app.use(errorHandler);

// Importing the app does not open ports or connect to a database. This also lets
// integration tests use an isolated database and a temporary HTTP port.
module.exports = app;
