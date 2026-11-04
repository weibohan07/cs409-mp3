'use strict';

const express = require('express');
const User = require('../models/user');
const { listResources, getResource } = require('../lib/query');
const { createUser, replaceUser, deleteUser } = require('../services/users');

const router = express.Router();
const bodyOptions = (req) => ({ form: Boolean(req.is('application/x-www-form-urlencoded')) });

router.get('/', async (req, res) => {
  const data = await listResources(User, req.query);
  res.status(200).json({ message: 'Users retrieved successfully.', data });
});

router.post('/', async (req, res) => {
  const data = await createUser(req.body, bodyOptions(req));
  res.status(201).json({ message: 'User created successfully.', data });
});

router.get('/:id', async (req, res) => {
  const data = await getResource(User, req.params.id, req.query, 'User');
  res.status(200).json({ message: 'User retrieved successfully.', data });
});

router.put('/:id', async (req, res) => {
  const data = await replaceUser(req.params.id, req.body, bodyOptions(req));
  res.status(200).json({ message: 'User replaced successfully.', data });
});

router.delete('/:id', async (req, res) => {
  await deleteUser(req.params.id);
  // The course autograder expects 204 No Content for successful DELETE.
  res.status(204).end();
});

module.exports = router;
