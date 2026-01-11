const express = require('express');
const { WorkProductV2 } = require('../models/WorkProductV2');
const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { sanitizeFileName, validateUploadFileName } = require('../utils/videoEditHelpers');
const { printLog } = require('../constants');

/**
 * Factory to create routes related to video editing and clip storage.
 *
 * Dependencies are injected from server.js to avoid re-initializing
 * shared services like clipUtils and clipSpacesManager.
 *
 * @param {Object} deps
 * @param {Object} deps.clipUtils - Instance of ClipUtils
 * @param {Function} deps.verifyPodcastAdminMiddleware - Middleware for podcast admin JWT auth
 * @param {Object} deps.clipSpacesManager - DigitalOceanSpacesManager instance for clip bucket
 * @returns {express.Router}
 */
function createVideoEditRoutes({ clipUtils, verifyPodcastAdminMiddleware, clipSpacesManager }) {
  const router = express.Router();

  /// Video Editing Endpoints

  // Create a new video edit
  router.post('/api/edit-video', verifyPodcastAdminMiddleware, async (req, res) => {
    const debugPrefix = `[EDIT-VIDEO][${Date.now()}]`;
    console.log(`${debugPrefix} ==== /api/edit-video ENDPOINT CALLED ====`);
    const { cdnUrl, startTime, endTime, useSubtitles = false, subtitles = null, chunk_size } = req.body;

    console.log(`${debugPrefix} Request body: ${JSON.stringify(req.body)}`);
    
    // Validate required parameters
    if (!cdnUrl) {
        console.error(`${debugPrefix} Missing required parameter: cdnUrl`);
        return res.status(400).json({ error: 'cdnUrl is required' });
    }

    if (startTime === undefined || endTime === undefined) {
        console.error(`${debugPrefix} Missing required parameters: startTime and endTime`);
        return res.status(400).json({ error: 'startTime and endTime are required' });
    }

    if (typeof startTime !== 'number' || typeof endTime !== 'number') {
        console.error(`${debugPrefix} Invalid parameter types: startTime and endTime must be numbers`);
        return res.status(400).json({ error: 'startTime and endTime must be numbers' });
    }

    try {
        // Normalize chunk size: default 1, max 5, min 1
        const requestedChunkSize = parseInt(chunk_size, 10);
        const chunkSize = Math.min(Math.max(Number.isFinite(requestedChunkSize) ? requestedChunkSize : 1, 1), 5);
        console.log(`${debugPrefix} Processing edit request for: ${cdnUrl}`);
        console.log(`${debugPrefix} Time range: ${startTime}s to ${endTime}s (${endTime - startTime}s duration)`);
        
        const result = await clipUtils.processEditRequest(
          cdnUrl,
          startTime,
          endTime,
          useSubtitles,
          req.podcastAdmin?.feedId,
          subtitles,
          chunkSize
        );
        
        console.log(`${debugPrefix} Edit request processed successfully: ${JSON.stringify(result)}`);
        return res.status(202).json(result);

    } catch (error) {
        console.error(`${debugPrefix} Error in edit-video endpoint: ${error.message}`);
        console.error(`${debugPrefix} Stack trace: ${error.stack}`);
        return res.status(500).json({ 
            error: 'Failed to process edit request',
            details: error.message 
        });
    }
  });

  // Status check endpoint for video edits
  router.get('/api/edit-status/:lookupHash', async (req, res) => {
    const { lookupHash } = req.params;
    const debugPrefix = `[EDIT-STATUS][${lookupHash}]`;

    try {
        console.log(`${debugPrefix} Checking status for edit: ${lookupHash}`);
        
        const edit = await WorkProductV2.findOne({ lookupHash });

        if (!edit) {
            console.log(`${debugPrefix} Edit not found`);
            return res.status(404).json({ status: 'not_found' });
        }

        if (edit.status === 'completed' && edit.cdnFileId) {
            console.log(`${debugPrefix} Edit completed: ${edit.cdnFileId}`);
            return res.json({
                status: 'completed',
                url: edit.cdnFileId,
                lookupHash
            });
        }

        if (edit.status === 'failed') {
            console.log(`${debugPrefix} Edit failed: ${edit.error}`);
            return res.json({
                status: 'failed',
                error: edit.error,
                lookupHash
            });
        }

        console.log(`${debugPrefix} Edit still processing, status: ${edit.status}`);
        return res.json({
            status: edit.status || 'processing',
            lookupHash
        });

    } catch (error) {
        console.error(`${debugPrefix} Error checking edit status: ${error.message}`);
        return res.status(500).json({ 
            error: 'Failed to check edit status',
            details: error.message 
        });
    }
  });

  // Get all child edits of a parent video file
  router.get('/api/edit-children/:parentFileName', verifyPodcastAdminMiddleware, async (req, res) => {
    const { parentFileName } = req.params;
    const debugPrefix = `[EDIT-CHILDREN][${parentFileName}]`;

    try {
      const t0 = Date.now();
      printLog(`⏱️  ${debugPrefix} start`);
      console.log(`${debugPrefix} Getting children for parent: ${parentFileName}`);
      
      // Remove extension from parent filename for base matching
      const parentFileBase = parentFileName.replace(/\.[^/.]+$/, "");
      printLog(`⏱️  ${debugPrefix} parentFileBase=${parentFileBase} (+${Date.now() - t0}ms)`);

      const feedId = req.podcastAdmin?.feedId;
      printLog(`⏱️  ${debugPrefix} feedId=${feedId} (+${Date.now() - t0}ms)`);
      
      // Try cache first
      const tCache = Date.now();
      // Important: don't auto-trigger a background refresh here, because this endpoint
      // will explicitly await refresh on miss (avoids double Mongo queries on cold cache).
      const cachedData = await global.editChildrenCache.getChildren(parentFileBase, feedId, { triggerRefresh: false });
      printLog(`⏱️  ${debugPrefix} cacheLookup done (+${Date.now() - tCache}ms, total +${Date.now() - t0}ms)`);
      
      if (cachedData) {
        console.log(`${debugPrefix} Returning cached data with ${cachedData.childCount} children`);
        printLog(`⏱️  ${debugPrefix} respond cached=true childCount=${cachedData.childCount} (total +${Date.now() - t0}ms)`);
        return res.json({
          parentFileName,
          parentFileBase,
          childCount: cachedData.childCount,
          children: cachedData.children,
          cached: true,
          lastUpdated: cachedData.lastUpdated
        });
      }

      // Cache miss - fetch fresh data (single path: await cache refresh to avoid double DB hits)
      printLog(`⏱️  ${debugPrefix} cache miss -> refreshChildren (total +${Date.now() - t0}ms)`);
      const tRefresh = Date.now();
      const fresh = await global.editChildrenCache.refreshChildren(parentFileBase, feedId);
      printLog(`⏱️  ${debugPrefix} refreshChildren done (+${Date.now() - tRefresh}ms, total +${Date.now() - t0}ms)`);

      printLog(`⏱️  ${debugPrefix} respond cached=false childCount=${fresh.childCount} (total +${Date.now() - t0}ms)`);
      return res.json({
        parentFileName,
        parentFileBase,
        childCount: fresh.childCount,
        children: fresh.children,
        cached: false,
        lastUpdated: fresh.lastUpdated
      });

    } catch (error) {
      console.error(`${debugPrefix} Error getting child edits: ${error.message}`);
      return res.status(500).json({ 
        error: 'Failed to get child edits',
        details: error.message 
      });
    }
  });

  // Generate a pre-signed URL for direct uploads to the clip bucket
  router.post('/api/generate-presigned-url', verifyPodcastAdminMiddleware, async (req, res) => {
    const { fileName, fileType, acl = 'public-read', cacheControl = false } = req.body;

    if (!fileName || !fileType) {
      return res.status(400).json({ error: "File name and type are required" });
    }

    // Validate file name against basic safety and convention rules
    const fileNameCheck = validateUploadFileName(fileName);
    if (!fileNameCheck.ok) {
      return res.status(400).json({
        error: "invalid_filename",
        code: fileNameCheck.code,
        message: fileNameCheck.message,
        hint: "Try a simpler name like my-video-clip.mp4"
      });
    }

    // Validate allowed file types
    const allowedFileTypes = [
      // Audio formats
      'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm', 
      'audio/aac', 'audio/flac', 'audio/x-ms-wma', 'audio/vnd.wav', 'audio/basic',
      'audio/x-aiff', 'audio/x-m4a', 'audio/x-matroska', 'audio/xm', 'audio/midi',
      // Image formats
      'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/tiff', 'image/bmp',
      'image/svg+xml', 'image/x-icon',
      // Video formats
      'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-msvideo', 
      'video/x-flv', 'video/x-matroska', 'video/3gpp', 'video/3gpp2', 'video/x-m4v',
      'video/mpeg', 'video/avi', 'video/mov', 'video/x-ms-wmv', 'video/x-ms-asf',
      // Documents
      'application/pdf'
    ];

    if (!allowedFileTypes.includes(fileType)) {
      return res.status(400).json({ 
        error: "File type not allowed",
        allowedTypes: allowedFileTypes
      });
    }

    try {
      // Check if clipSpacesManager is initialized
      if (!clipSpacesManager) {
        return res.status(503).json({ error: "Clip storage service not available" });
      }
      
      // Get the clip bucket name from environment variable - same as used in ClipUtils
      const bucketName = process.env.SPACES_CLIP_BUCKET_NAME;
      if (!bucketName) {
        return res.status(503).json({ error: "Clip bucket not configured" });
      }
      
      // Use feedId from verified podcast admin
      const { feedId } = req.podcastAdmin;
      
      // Generate a safe path using the feedId and a timestamp to ensure uniqueness
      const timestamp = new Date().getTime();
      
      // Use the same path structure that works for ClipUtils
      const key = `jamie-pro/${feedId}/uploads/${timestamp}-${sanitizeFileName(fileName)}`;
      const expiresIn = 3600; // URL validity in seconds (1 hour)
      
      // Set max file size based on file type (100MB for audio/video, 10MB for images, 5MB for docs)
      let maxSizeBytes = 100 * 1024 * 1024; // Default to 100MB
      
      if (fileType.startsWith('image/')) {
        maxSizeBytes = 10 * 1024 * 1024; // 10MB for images
      } else if (fileType === 'application/pdf') {
        maxSizeBytes = 5 * 1024 * 1024; // 5MB for PDFs
      }

      // Generate pre-signed URL using the clip-specific spaces manager
      const uploadUrl = await clipSpacesManager.generatePresignedUploadUrl(
        bucketName, 
        key, 
        fileType, 
        expiresIn,
        maxSizeBytes,
        acl,
        cacheControl
      );

      console.log(`Generated pre-signed URL for ${bucketName}/${key}${cacheControl ? ' with Cache-Control' : ''}`);

      res.json({ 
        uploadUrl, 
        key,
        feedId,
        publicUrl: `https://${bucketName}.${process.env.SPACES_ENDPOINT}/${key}`,
        maxSizeBytes,
        maxSizeMB: Math.round(maxSizeBytes / (1024 * 1024)),
        cacheControl: cacheControl || false
      });
    } catch (error) {
      console.error("Error generating pre-signed URL:", error);
      res.status(500).json({ error: "Could not generate pre-signed URL" });
    }
  });

  // List uploads for the authenticated podcast admin, with optional child edit relationships
  router.get('/api/list-uploads', verifyPodcastAdminMiddleware, async (req, res) => {
    try {
      const t0 = Date.now();
      printLog(`⏱️  [LIST-UPLOADS] start`);
      // Check if clipSpacesManager is initialized
      if (!clipSpacesManager) {
        return res.status(503).json({ error: "Clip storage service not available" });
      }
      
      // Get the clip bucket name from environment variable - same as used in ClipUtils
      const bucketName = process.env.SPACES_CLIP_BUCKET_NAME;
      if (!bucketName) {
        return res.status(503).json({ error: "Clip bucket not configured" });
      }
      
      // Use feedId from verified podcast admin
      const { feedId } = req.podcastAdmin;
      
      // Define the prefix for this podcast admin's uploads
      const prefix = `jamie-pro/${feedId}/uploads/`;
      
      // Parse pagination parameters
      const pageSize = 50; // Fixed page size of 50 items
      const page = parseInt(req.query.page) || 1; // Default to page 1 if not specified
      const includeChildren = req.query.includeChildren === 'true'; // Default to false for performance
      printLog(`⏱️  [LIST-UPLOADS] params feedId=${feedId} page=${page} includeChildren=${includeChildren} (+${Date.now() - t0}ms)`);
      
      if (page < 1) {
        return res.status(400).json({ error: "Page number must be 1 or greater" });
      }
      
      // Create a new S3 client for this operation
      const client = clipSpacesManager.createClient();
      printLog(`⏱️  [LIST-UPLOADS] s3Client created (+${Date.now() - t0}ms)`);
      
      // Fetch ALL objects from S3 (we'll paginate after sorting)
      let continuationToken = null;
      let allContents = [];
      let hasMoreItems = true;
      let totalCount = 0;
      let directoryCount = 0; // Track total number of directories
      
      // Fetch all objects from S3 to enable proper sorting
      let batchCount = 0;
      while (hasMoreItems) {
        batchCount++;
        const tBatch = Date.now();
        const listParams = {
          Bucket: bucketName,
          Prefix: prefix,
          MaxKeys: 1000 // Fetch in larger batches for efficiency
        };
        
        // Add the continuation token if we have one from a previous request
        if (continuationToken) {
          listParams.ContinuationToken = continuationToken;
        }
        
        console.log(`S3 Batch ${batchCount}: Fetching with prefix: ${prefix}`);
        printLog(`⏱️  [LIST-UPLOADS] s3 batch=${batchCount} send start continuation=${Boolean(continuationToken)}`);
        
        // Execute the command
        const command = new ListObjectsV2Command(listParams);
        const response = await client.send(command);
        printLog(`⏱️  [LIST-UPLOADS] s3 batch=${batchCount} send done items=${response.Contents?.length || 0} truncated=${Boolean(response.IsTruncated)} (+${Date.now() - tBatch}ms, total +${Date.now() - t0}ms)`);
        
        console.log(`S3 Batch ${batchCount}: Got ${response.Contents?.length || 0} items, IsTruncated: ${response.IsTruncated}`);
        
        // Count directories in this response
        const directoriesInThisPage = (response.Contents || []).filter(item => item.Key.endsWith('/')).length;
        directoryCount += directoriesInThisPage;
        
        // Update total count (including directories for now)
        totalCount += response.Contents?.length || 0;
        
        // Add all contents to our collection
        allContents = allContents.concat(response.Contents || []);
        
        // Check if there are more items to fetch
        hasMoreItems = response.IsTruncated;
        
        // Update the continuation token for the next request
        continuationToken = response.IsTruncated ? response.NextContinuationToken : null;
      }
      
      console.log(`S3 Fetch Complete: ${batchCount} batches, ${allContents.length} total items, ${directoryCount} directories`);
      printLog(`⏱️  [LIST-UPLOADS] s3 fetch complete batches=${batchCount} totalItems=${allContents.length} dirs=${directoryCount} (total +${Date.now() - t0}ms)`);
      
      // Process the results to make them more user-friendly
      const tProcess = Date.now();
      const uploads = allContents
        .filter(item => !item.Key.endsWith('/')) // Filter out directory entries
        .filter(item => !item.Key.includes('-children/')) // Filter out child edit files from main list
        .map(item => {
          // Extract just the filename from the full path
          const fileName = item.Key.replace(prefix, '');
          
          return {
            key: item.Key,
            fileName: fileName,
            size: item.Size,
            lastModified: item.LastModified,
            publicUrl: `https://${bucketName}.${process.env.SPACES_ENDPOINT}/${item.Key}`
          };
        })
        // Sort by lastModified DESC (most recent first), with deterministic secondary sort by key
        .sort((a, b) => {
          // Convert to Date objects for proper comparison
          const dateA = new Date(a.lastModified);
          const dateB = new Date(b.lastModified);
          const timeDiff = dateB.getTime() - dateA.getTime();
          
          if (timeDiff !== 0) return timeDiff;
          return a.key.localeCompare(b.key); // Secondary sort for consistency
        });
      printLog(`⏱️  [LIST-UPLOADS] process+sort done uploads=${uploads.length} (+${Date.now() - tProcess}ms, total +${Date.now() - t0}ms)`);
      
      console.log(`Total files found: ${uploads.length}`);
      console.log(`First 3 files (most recent):`, uploads.slice(0, 3).map(u => ({ fileName: u.fileName, lastModified: u.lastModified })));
      console.log(`Last 3 files (oldest):`, uploads.slice(-3).map(u => ({ fileName: u.fileName, lastModified: u.lastModified })));

      // Apply server-side pagination to sorted results
      const tPaginate = Date.now();
      const startIndex = (page - 1) * pageSize;
      const endIndex = startIndex + pageSize;
      const paginatedUploads = uploads.slice(startIndex, endIndex);
      printLog(`⏱️  [LIST-UPLOADS] paginate done paginated=${paginatedUploads.length} (+${Date.now() - tPaginate}ms, total +${Date.now() - t0}ms)`);
      
      // Calculate pagination metadata
      const totalFileCount = uploads.length; // Total files after filtering
      const hasNextPage = endIndex < totalFileCount;
      const hasPreviousPage = page > 1;
      
      console.log(`Pagination debug - Page: ${page}, Total files: ${totalFileCount}, Start: ${startIndex}, End: ${endIndex}, Paginated count: ${paginatedUploads.length}`);

      // Add child relationship data if requested
      if (includeChildren) {
        console.log(`Adding child relationship data for ${paginatedUploads.length} uploads`);
        const tChildren = Date.now();
        
        try {
          // Get all file bases for batch query (only for paginated results)
          const fileBases = paginatedUploads.map(upload => upload.fileName.replace(/\.[^/.]+$/, ""));
          
          // DB queries:
          // - Scoped (fast path): includes result.feedId for modern docs
          // - Legacy fallback: includes docs missing result.feedId (backward compatible)
          const tScoped = Date.now();
          const scopedEdits = await WorkProductV2.find({
            type: 'video-edit',
            'result.feedId': feedId,
            'result.parentFileBase': { $in: fileBases }
          }).sort({ createdAt: -1 });
          printLog(`⏱️  [LIST-UPLOADS] includeChildren dbFind scoped done edits=${scopedEdits.length} (+${Date.now() - tScoped}ms, total +${Date.now() - t0}ms)`);

          const tLegacy = Date.now();
          const legacyEdits = await WorkProductV2.find({
            type: 'video-edit',
            'result.feedId': { $exists: false },
            'result.parentFileBase': { $in: fileBases }
          }).sort({ createdAt: -1 });
          printLog(`⏱️  [LIST-UPLOADS] includeChildren dbFind legacy done edits=${legacyEdits.length} (+${Date.now() - tLegacy}ms, total +${Date.now() - t0}ms)`);

          const allChildEdits = scopedEdits.concat(legacyEdits);
          printLog(`⏱️  [LIST-UPLOADS] includeChildren dbFind combined edits=${allChildEdits.length} (+${Date.now() - tChildren}ms, total +${Date.now() - t0}ms)`);
          
          console.log(`Found ${allChildEdits.length} total child edits`);
          
          // Group child edits by parent file base
          const childEditsByParent = {};
          allChildEdits.forEach(edit => {
            const parentBase = edit.result.parentFileBase;
            if (!childEditsByParent[parentBase]) {
              childEditsByParent[parentBase] = [];
            }
            childEditsByParent[parentBase].push(edit);
          });
          
          // Add children to each upload
          paginatedUploads.forEach(upload => {
            const fileBase = upload.fileName.replace(/\.[^/.]+$/, "");
            const childEdits = childEditsByParent[fileBase] || [];
            
            upload.children = childEdits.map(edit => ({
              lookupHash: edit.lookupHash,
              status: edit.status,
              url: edit.cdnFileId,
              editRange: `${edit.result.editStart}s-${edit.result.editEnd}s`,
              duration: edit.result.editDuration,
              createdAt: edit.createdAt
            }));

            upload.childCount = upload.children.length;
            upload.hasChildren = upload.children.length > 0;
          });
          
        } catch (error) {
          console.error(`Failed to get children data: ${error.message}`);
          printLog(`⏱️  [LIST-UPLOADS] includeChildren failed err=${error.message} (total +${Date.now() - t0}ms)`);
          // Set empty children for all uploads on error
          paginatedUploads.forEach(upload => {
            upload.children = [];
            upload.childCount = 0;
            upload.hasChildren = false;
          });
        }
      }
      
      // Return the list of uploads with pagination metadata
      printLog(`⏱️  [LIST-UPLOADS] respond (total +${Date.now() - t0}ms)`);
      res.json({
        uploads: paginatedUploads,
        pagination: {
          page,
          pageSize,
          hasNextPage,
          hasPreviousPage,
          totalCount: totalFileCount
        },
        feedId,
        includeChildren,
        childrenSummary: includeChildren ? {
          enabled: true,
          note: 'Child edits are included for each upload when available'
        } : {
          enabled: false,
          note: 'Child edits have been omitted for performance. Set includeChildren=true to include them.'
        }
      });
    } catch (error) {
      console.error("Error listing uploads:", error);
      res.status(500).json({ error: "Could not list uploads" });
    }
  });

  return router;
}

module.exports = createVideoEditRoutes;

