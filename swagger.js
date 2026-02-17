const swaggerAutogen = require('swagger-autogen')({ openapi: '3.0.0' });
const fs = require('fs');

const doc = {
  info: {
    title: 'Pull That Up Jamie API',
    version: '1.0.0',
    description:
      'Public API for Pull That Up Jamie — a podcast search and research platform. ' +
      'Provides semantic search across podcast transcripts, corpus navigation for AI agents, ' +
      'research session management, and (upcoming) Lightning-based agent authentication.',
    contact: {
      name: 'Pull That Up Jamie',
      url: 'https://pullthatupjamie.ai'
    },
    license: {
      name: 'ISC'
    }
  },
  servers: [
    {
      url: 'https://pullthatupjamie.ai',
      description: 'Production'
    },
    {
      url: 'http://localhost:3000',
      description: 'Local development'
    }
  ],
  tags: [
    {
      name: 'Corpus Discovery',
      description: 'Read-only endpoints for navigating the podcast corpus hierarchy (feeds, episodes, chapters, topics, people). Designed for AI agents.'
    },
    {
      name: 'Search',
      description: 'Semantic search across podcast transcripts using vector embeddings.'
    },
    {
      name: 'Research Sessions',
      description: 'Create, retrieve, share, and analyze research sessions — curated collections of podcast clips.'
    },
    {
      name: 'Agent Auth',
      description: 'Lightning-based pay-per-use system for agent API access. Pre-pay any amount in sats via Lightning invoice, then each API call deducts its USD-equivalent cost at the current exchange rate. No tiers or discounts — just pay for what you use. The preimage serves as a stateless auth credential. (Not yet implemented — see Issue #63). Future: Nostr-based authentication may be supported as an alternative identity path for agents.'
    }
  ],
  components: {
    securitySchemes: {
      AgentCredential: {
        type: 'apiKey',
        in: 'header',
        name: 'Authorization',
        description: 'Lightning preimage credential in format "preimage:paymentHash". Used for agent auth endpoints.'
      },
      BearerJWT: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT token for authenticated user sessions.'
      },
      ClientId: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Client-Id',
        description: 'Anonymous client identifier for session tracking without authentication.'
      }
    },
    schemas: {
      Pagination: {
        type: 'object',
        properties: {
          page: { type: 'integer', example: 1 },
          totalPages: { type: 'integer', example: 5 },
          totalCount: { type: 'integer', example: 250 },
          limit: { type: 'integer', example: 50 },
          hasMore: { type: 'boolean', example: true }
        }
      },
      Feed: {
        type: 'object',
        properties: {
          feedId: { type: 'string', example: '1015378' },
          title: { type: 'string', example: 'What Bitcoin Did' },
          author: { type: 'string', example: 'Peter McCormack' },
          description: { type: 'string' },
          episodeCount: { type: 'integer', example: 824 },
          imageUrl: { type: 'string', format: 'uri' }
        }
      },
      Episode: {
        type: 'object',
        properties: {
          guid: { type: 'string' },
          title: { type: 'string' },
          creator: { type: 'string' },
          description: { type: 'string' },
          publishedDate: { type: 'string' },
          duration: { type: 'string' },
          imageUrl: { type: 'string', format: 'uri' },
          guests: { type: 'array', items: { type: 'string' } }
        }
      },
      Chapter: {
        type: 'object',
        properties: {
          pineconeId: { type: 'string' },
          chapterNumber: { type: 'integer' },
          headline: { type: 'string' },
          keywords: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
          startTime: { type: 'number' },
          endTime: { type: 'number' },
          duration: { type: 'number' }
        }
      },
      Topic: {
        type: 'object',
        properties: {
          keyword: { type: 'string', example: 'artificial intelligence' },
          count: { type: 'integer', example: 150 },
          feeds: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                feedId: { type: 'string' },
                title: { type: 'string' }
              }
            }
          },
          sampleEpisodes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                guid: { type: 'string' },
                title: { type: 'string' }
              }
            }
          }
        }
      },
      Person: {
        type: 'object',
        properties: {
          name: { type: 'string', example: 'Elon Musk' },
          role: { type: 'string', enum: ['guest', 'creator'] },
          appearances: { type: 'integer', example: 3 },
          feeds: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                feedId: { type: 'string' },
                title: { type: 'string' }
              }
            }
          },
          recentEpisodes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                guid: { type: 'string' },
                title: { type: 'string' },
                publishedDate: { type: 'string' }
              }
            }
          }
        }
      },
      SearchResult: {
        type: 'object',
        properties: {
          shareUrl: { type: 'string', format: 'uri' },
          shareLink: { type: 'string' },
          quote: { type: 'string' },
          episode: { type: 'string' },
          creator: { type: 'string' },
          audioUrl: { type: 'string', format: 'uri' },
          episodeImage: { type: 'string', format: 'uri' },
          listenLink: { type: 'string' },
          date: { type: 'string' },
          similarity: {
            type: 'object',
            properties: {
              combined: { type: 'number', example: 0.8542 },
              vector: { type: 'number', example: 0.8542 }
            }
          },
          timeContext: {
            type: 'object',
            properties: {
              start_time: { type: 'number' },
              end_time: { type: 'number' }
            }
          }
        }
      },
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          message: { type: 'string' },
          details: { type: 'string' }
        }
      }
    }
  }
};

const outputFile = './openapi.json';

// Only use server.js as entry — swagger-autogen follows require() to pick up
// route file annotations with correct mount prefixes.
const routes = ['./server.js'];

// Allowed tags — only endpoints with one of these tags survive the filter.
const ALLOWED_TAGS = new Set([
  'Corpus Discovery',
  'Search',
  'Research Sessions',
  'Agent Auth'
]);

swaggerAutogen(outputFile, routes, doc).then(({ success, data }) => {
  if (!success) {
    console.error('Failed to generate OpenAPI spec');
    process.exit(1);
  }

  // Post-process: keep only paths whose operations carry an allowed tag.
  const spec = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
  const filteredPaths = {};

  for (const [path, methods] of Object.entries(spec.paths)) {
    const filteredMethods = {};
    for (const [method, operation] of Object.entries(methods)) {
      const tags = operation.tags || [];
      if (tags.some(t => ALLOWED_TAGS.has(t))) {
        filteredMethods[method] = operation;
      }
    }
    if (Object.keys(filteredMethods).length > 0) {
      filteredPaths[path] = filteredMethods;
    }
  }

  spec.paths = filteredPaths;

  fs.writeFileSync(outputFile, JSON.stringify(spec, null, 2));

  const pathCount = Object.keys(filteredPaths).length;
  let endpointCount = 0;
  for (const methods of Object.values(filteredPaths)) {
    endpointCount += Object.keys(methods).length;
  }
  console.log(`OpenAPI spec generated → openapi.json (${endpointCount} endpoints across ${pathCount} paths)`);
});
