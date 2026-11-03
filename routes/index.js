'use strict';

const express = require('express');
const router = express.Router();

router.use('/', require('./home'));
router.use('/users', require('./users'));
router.use('/tasks', require('./tasks'));

module.exports = router;
