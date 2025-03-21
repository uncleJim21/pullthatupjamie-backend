const express = require('express');
const router = express.Router();
const {
  getEpisodeByGuid,
  getParagraphWithEpisodeData,
  getFeedById,
  getParagraphWithFeedData
} = require('../agent-tools/pineconeTools.js');

// Debug endpoint for episode retrieval
router.get('/episode/:guid', async (req, res) => {
  try {
    const { guid } = req.params;
    console.log(`[DEBUG] Fetching episode data for GUID: ${guid}`);
    
    const episode = await getEpisodeByGuid(guid);
    
    if (!episode) {
      return res.status(404).json({ 
        error: 'Episode not found',
        guid 
      });
    }

    res.json({ episode });
  } catch (error) {
    console.error('Error fetching episode:', error);
    res.status(500).json({ 
      error: 'Failed to fetch episode data',
      details: error.message,
      guid: req.params.guid
    });
  }
});

// Debug endpoint for paragraph with episode data
router.get('/paragraph-with-episode/:paragraphId', async (req, res) => {
  try {
    const { paragraphId } = req.params;
    console.log(`[DEBUG] Fetching paragraph with episode data for ID: ${paragraphId}`);
    
    const result = await getParagraphWithEpisodeData(paragraphId);
    
    if (!result || !result.paragraph) {
      return res.status(404).json({ 
        error: 'Paragraph not found',
        paragraphId 
      });
    }

    res.json(result);
  } catch (error) {
    console.error('Error fetching paragraph with episode:', error);
    res.status(500).json({ 
      error: 'Failed to fetch paragraph with episode data',
      details: error.message,
      paragraphId: req.params.paragraphId
    });
  }
});

// Debug endpoint for feed retrieval
router.get('/feed/:feedId', async (req, res) => {
  try {
    const { feedId } = req.params;
    console.log(`[DEBUG] Fetching feed data for feedId: ${feedId}`);
    
    const feed = await getFeedById(feedId);
    
    if (!feed) {
      return res.status(404).json({ 
        error: 'Feed not found',
        feedId 
      });
    }

    res.json({ feed });
  } catch (error) {
    console.error('Error fetching feed:', error);
    res.status(500).json({ 
      error: 'Failed to fetch feed data',
      details: error.message,
      feedId: req.params.feedId
    });
  }
});

// Debug endpoint for paragraph with feed data
router.get('/paragraph-with-feed/:paragraphId', async (req, res) => {
  try {
    const { paragraphId } = req.params;
    console.log(`[DEBUG] Fetching paragraph with feed data for ID: ${paragraphId}`);
    
    const result = await getParagraphWithFeedData(paragraphId);
    
    if (!result || !result.paragraph) {
      return res.status(404).json({ 
        error: 'Paragraph not found',
        paragraphId 
      });
    }

    res.json(result);
  } catch (error) {
    console.error('Error fetching paragraph with feed:', error);
    res.status(500).json({ 
      error: 'Failed to fetch paragraph with feed data',
      details: error.message,
      paragraphId: req.params.paragraphId
    });
  }
});

module.exports = router; 