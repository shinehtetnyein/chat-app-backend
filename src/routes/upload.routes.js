const express = require('express');
const { requireAuth } = require('../middlewares/auth.middleware');
const { getPresignedUrl } = require('../controllers/upload.controller');

const router = express.Router();

// POST /api/upload/presign  { fileName, fileType, fileSize }
// -> { uploadUrl, key, publicUrl }
router.post('/presign', requireAuth, getPresignedUrl);

module.exports = router;
