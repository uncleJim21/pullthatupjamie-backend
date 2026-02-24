const express = require('express');
const { authenticateToken } = require('../middleware/authMiddleware');
const { findUserFromRequest } = require('../utils/userLookup');
const { v4: uuidv4 } = require('uuid');
const { validateUploadFileName } = require('../utils/videoEditHelpers');

const ALLOWED_FILE_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/tiff', 'image/bmp',
  'image/svg+xml', 'image/x-icon',
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-msvideo',
  'video/x-flv', 'video/x-matroska', 'video/3gpp', 'video/3gpp2', 'video/x-m4v',
  'video/mpeg', 'video/avi', 'video/mov', 'video/x-ms-wmv', 'video/x-ms-asf',
  'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm',
  'audio/aac', 'audio/flac', 'audio/x-ms-wma', 'audio/vnd.wav', 'audio/basic',
  'audio/x-aiff', 'audio/x-m4a', 'audio/x-matroska', 'audio/xm', 'audio/midi',
];

/**
 * Factory — mirrors the pattern in videoEditRoutes.js.
 * clipSpacesManager is injected from server.js.
 */
function createUserUploadRoutes({ clipSpacesManager }) {
  const router = express.Router();

  router.post('/presigned-url', authenticateToken, async (req, res) => {
    try {
      const { fileName, fileType, acl = 'public-read', cacheControl = false } = req.body;

      if (!fileName || !fileType) {
        return res.status(400).json({ error: "File name and type are required" });
      }

      const fileNameCheck = validateUploadFileName(fileName);
      if (!fileNameCheck.ok) {
        return res.status(400).json({
          error: "invalid_filename",
          code: fileNameCheck.code,
          message: fileNameCheck.message,
          hint: "Try a simpler name like my-image.jpg"
        });
      }

      if (!ALLOWED_FILE_TYPES.includes(fileType)) {
        return res.status(400).json({
          error: "File type not allowed",
          allowedTypes: ALLOWED_FILE_TYPES
        });
      }

      const user = await findUserFromRequest(req, '_id');
      if (!user) {
        return res.status(400).json({ error: 'User not found' });
      }

      if (!clipSpacesManager) {
        return res.status(503).json({ error: "Upload service not available" });
      }

      const bucketName = process.env.SPACES_CLIP_BUCKET_NAME;
      if (!bucketName) {
        return res.status(503).json({ error: "Upload service not configured" });
      }

      const userId = user._id.toString();
      const uniqueId = uuidv4();
      const key = `user-uploads/${userId}/${uniqueId}/${fileName}`;

      const uploadUrl = await clipSpacesManager.generatePresignedUploadUrl(
        bucketName,
        key,
        fileType,
        300,              // 5 minutes
        100 * 1024 * 1024, // 100 MB
        acl,
        cacheControl
      );

      const endpoint = process.env.SPACES_ENDPOINT || 'nyc3.digitaloceanspaces.com';
      const publicUrl = `https://${bucketName}.${endpoint.replace(/^https?:\/\//, '')}/${key}`;

      res.json({
        uploadUrl,
        key,
        publicUrl,
        cacheControl: cacheControl || null
      });

    } catch (error) {
      console.error('Error generating presigned URL:', error);
      res.status(500).json({
        error: 'Failed to generate upload URL',
        message: error.message
      });
    }
  });

  return router;
}

module.exports = createUserUploadRoutes;
