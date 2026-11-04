'use strict';

const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.status(200).json({
    message: 'Task management API is running.',
    data: { users: '/api/users', tasks: '/api/tasks' },
  });
});

module.exports = router;
