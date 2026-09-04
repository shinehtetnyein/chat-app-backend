const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');

const region = process.env.AWS_REGION || 'us-east-1';
const BUCKET = process.env.S3_BUCKET_NAME || 'chatapp-uploads-bucket';

let s3;
try {
  s3 = new S3Client({
    region,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'mock',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'mock',
    },
  });
} catch (err) {
  console.warn('S3 Client initialization warning:', err.message);
}

/**
 * Generates a short-lived presigned PUT URL. The client uploads the file
 * bytes directly to S3 with this URL.
 */
async function createPresignedUploadUrl({ userId, fileName, fileType }) {
  const ext = fileName.includes('.') ? fileName.split('.').pop() : 'bin';
  const key = `uploads/${userId}/${crypto.randomUUID()}.${ext}`;

  if (!s3 || !process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID === 'mock' || process.env.AWS_ACCESS_KEY_ID === 'mock-access-key-id') {
    // Fallback/Mock Presigned URL for testing without active AWS credentials
    const mockUploadUrl = `http://localhost:${process.env.PORT || 5000}/api/upload/mock-upload?key=${key}`;
    // key is "uploads/<userId>/<uuid>.ext" — Express static already maps ./uploads -> /uploads,
    // so strip the leading "uploads/" to avoid a double-prefix in the served URL.
    const relKey = key.startsWith('uploads/') ? key.slice('uploads/'.length) : key;
    const mockPublicUrl = `http://localhost:${process.env.PORT || 5000}/uploads/${relKey}`;
    return { uploadUrl: mockUploadUrl, key, publicUrl: mockPublicUrl };
  }

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: fileType,
  });

  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
  const publicUrl = `https://${BUCKET}.s3.${region}.amazonaws.com/${key}`;

  return { uploadUrl, key, publicUrl };
}

async function deleteObject(key) {
  if (s3) {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  }
}

module.exports = { createPresignedUploadUrl, deleteObject };
