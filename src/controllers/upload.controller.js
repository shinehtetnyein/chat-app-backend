const { createPresignedUploadUrl } = require('../services/s3.service');

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];

async function getPresignedUrl(req, res) {
  const { fileName, fileType, fileSize } = req.body;

  if (!fileName || !fileType) {
    return res.status(400).json({ error: 'fileName and fileType are required' });
  }
  if (!ALLOWED_TYPES.includes(fileType)) {
    return res.status(400).json({ error: 'File type not allowed' });
  }
  if (fileSize && fileSize > MAX_FILE_SIZE) {
    return res.status(400).json({ error: 'File exceeds 10MB limit' });
  }

  try {
    const { uploadUrl, key, publicUrl } = await createPresignedUploadUrl({
      userId: req.user.id,
      fileName,
      fileType,
    });
    res.json({ uploadUrl, key, publicUrl });
  } catch (err) {
    console.error('presign error', err);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
}

module.exports = { getPresignedUrl };
