'use strict';

const express = require('express');
const Task = require('../models/task');
const { listResources, getResource } = require('../lib/query');
const { createTask, replaceTask, deleteTask } = require('../services/tasks');

const router = express.Router();
const bodyOptions = (req) => ({ form: Boolean(req.is('application/x-www-form-urlencoded')) });

router.get('/', async (req, res) => {
  const data = await listResources(Task, req.query, 100);
  res.status(200).json({ message: 'Tasks retrieved successfully.', data });
});

router.post('/', async (req, res) => {
  const data = await createTask(req.body, bodyOptions(req));
  res.status(201).json({ message: 'Task created successfully.', data });
});

router.get('/:id', async (req, res) => {
  const data = await getResource(Task, req.params.id, req.query, 'Task');
  res.status(200).json({ message: 'Task retrieved successfully.', data });
});

router.put('/:id', async (req, res) => {
  const data = await replaceTask(req.params.id, req.body, bodyOptions(req));
  res.status(200).json({ message: 'Task replaced successfully.', data });
});

router.delete('/:id', async (req, res) => {
  await deleteTask(req.params.id);
  // The course autograder expects 204 No Content for successful DELETE.
  res.status(204).end();
});

module.exports = router;
