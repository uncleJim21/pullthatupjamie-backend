/**
 * UmapProjector.js
 * 
 * Utility for projecting high-dimensional embeddings (1536D) to 3D space using UMAP.
 * Used for galaxy view visualization of semantic search results.
 */

const { UMAP } = require('umap-js');

// Get random seed from environment or use default for reproducibility
const UMAP_RANDOM_SEED = parseInt(process.env.UMAP_RANDOM_SEED || '42', 10);

class UmapProjector {
  constructor(options = {}) {
    this.nComponents = options.nComponents || 3; // Output dimensions
    this.nNeighbors = options.nNeighbors || 15; // Balance local/global structure
    this.minDist = options.minDist || 0.1; // Minimum distance between points
    this.metric = options.metric || 'cosine'; // Match embedding similarity
    this.randomState = options.randomState || UMAP_RANDOM_SEED;
    this.maxRetries = options.maxRetries || 2;
    this.retryDelay = options.retryDelay || 100; // ms
  }

  /**
   * Project embeddings to 3D space
   * @param {Array<Array<number>>} embeddings - Array of embedding vectors
   * @returns {Promise<Array<{x: number, y: number, z: number}>>} - 3D coordinates
   */
  async project(embeddings) {
    const debugPrefix = `[UMAP-PROJECTOR][${Date.now()}]`;
    
    // Validate input
    if (!Array.isArray(embeddings) || embeddings.length === 0) {
      throw new Error('Embeddings must be a non-empty array');
    }

    // Check minimum points requirement
    if (embeddings.length < 4) {
      throw new Error(`UMAP requires at least 4 points. Received: ${embeddings.length}`);
    }

    console.log(`${debugPrefix} Starting UMAP projection for ${embeddings.length} embeddings`);
    console.time(`${debugPrefix} UMAP-Projection-Time`);

    let attempt = 0;
    let lastError = null;

    while (attempt < this.maxRetries) {
      try {
        // Create UMAP instance with seeded random
        let randomSeed = this.randomState + attempt * 1000; // Different seed per retry
        const umap = new UMAP({
          nComponents: this.nComponents,
          nNeighbors: Math.min(this.nNeighbors, embeddings.length - 1), // Can't exceed data size
          minDist: this.minDist,
          metric: this.metric,
          random: () => {
            // Simple seeded random for reproducibility
            randomSeed = (randomSeed * 9301 + 49297) % 233280;
            return randomSeed / 233280;
          }
        });

        console.log(`${debugPrefix} UMAP config:`, {
          nComponents: this.nComponents,
          nNeighbors: Math.min(this.nNeighbors, embeddings.length - 1),
          minDist: this.minDist,
          metric: this.metric,
          seed: this.randomState + attempt,
          attempt: attempt + 1
        });

        // Fit and transform
        const projection = umap.fit(embeddings);
        
        console.timeEnd(`${debugPrefix} UMAP-Projection-Time`);
        console.log(`${debugPrefix} UMAP projection completed successfully`);

        // Validate projection
        this.validateProjection(projection, embeddings.length);

        // Normalize coordinates to [-1, 1] range
        const normalized = this.normalizeCoordinates(projection);

        // Validate normalized distribution
        this.validateDistribution(normalized);

        console.log(`${debugPrefix} Projection validation passed`);
        
        return normalized;

      } catch (error) {
        lastError = error;
        attempt++;
        
        console.error(`${debugPrefix} UMAP projection attempt ${attempt} failed: ${error.message}`);
        
        if (attempt < this.maxRetries) {
          console.log(`${debugPrefix} Retrying in ${this.retryDelay}ms...`);
          await new Promise(resolve => setTimeout(resolve, this.retryDelay));
          this.retryDelay *= 2; // Exponential backoff
        }
      }
    }

    // All retries failed
    console.error(`${debugPrefix} UMAP projection failed after ${this.maxRetries} attempts`);
    throw new Error(`UMAP projection failed: ${lastError.message}`);
  }

  /**
   * Validate projection output
   * @param {Array<Array<number>>} projection - UMAP output
   * @param {number} expectedLength - Expected number of points
   */
  validateProjection(projection, expectedLength) {
    if (!Array.isArray(projection)) {
      throw new Error('UMAP projection output is not an array');
    }

    if (projection.length !== expectedLength) {
      throw new Error(`UMAP projection length mismatch. Expected: ${expectedLength}, Got: ${projection.length}`);
    }

    // Check for NaN or Infinity values
    for (let i = 0; i < projection.length; i++) {
      const point = projection[i];
      
      if (!Array.isArray(point) || point.length !== this.nComponents) {
        throw new Error(`Invalid point at index ${i}. Expected ${this.nComponents} dimensions.`);
      }

      for (let j = 0; j < point.length; j++) {
        if (!isFinite(point[j])) {
          throw new Error(`Invalid coordinate at point ${i}, dimension ${j}: ${point[j]}`);
        }
      }
    }
  }

  /**
   * Normalize coordinates to [-1, 1] range per axis
   * @param {Array<Array<number>>} projection - UMAP output
   * @returns {Array<{x: number, y: number, z: number}>} - Normalized coordinates
   */
  normalizeCoordinates(projection) {
    const debugPrefix = `[UMAP-NORMALIZE]`;
    
    // Find min/max per dimension
    const mins = Array(this.nComponents).fill(Infinity);
    const maxs = Array(this.nComponents).fill(-Infinity);

    projection.forEach(point => {
      point.forEach((value, dim) => {
        mins[dim] = Math.min(mins[dim], value);
        maxs[dim] = Math.max(maxs[dim], value);
      });
    });

    console.log(`${debugPrefix} Raw coordinate ranges:`, {
      x: `[${mins[0].toFixed(3)}, ${maxs[0].toFixed(3)}]`,
      y: `[${mins[1].toFixed(3)}, ${maxs[1].toFixed(3)}]`,
      z: `[${mins[2].toFixed(3)}, ${maxs[2].toFixed(3)}]`
    });

    // Normalize each point to [-1, 1] per axis
    const normalized = projection.map(point => {
      const coords = {};
      const axes = ['x', 'y', 'z'];
      
      point.forEach((value, dim) => {
        const range = maxs[dim] - mins[dim];
        if (range === 0) {
          // All points have same value on this axis
          coords[axes[dim]] = 0;
        } else {
          // Normalize to [-1, 1]
          coords[axes[dim]] = ((value - mins[dim]) / range) * 2 - 1;
        }
      });

      return coords;
    });

    console.log(`${debugPrefix} Normalized ${normalized.length} points to [-1, 1] range`);
    console.log(`${debugPrefix} Sample normalized point:`, normalized[0]);

    return normalized;
  }

  /**
   * Validate coordinate distribution (check for degenerate cases)
   * @param {Array<{x: number, y: number, z: number}>} coordinates - Normalized coordinates
   */
  validateDistribution(coordinates) {
    const debugPrefix = `[UMAP-VALIDATE-DIST]`;
    
    // Calculate standard deviation per axis
    const axes = ['x', 'y', 'z'];
    const stats = {};

    axes.forEach(axis => {
      const values = coordinates.map(c => c[axis]);
      const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
      const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
      const stdDev = Math.sqrt(variance);
      
      stats[axis] = {
        mean: mean.toFixed(4),
        stdDev: stdDev.toFixed(4),
        min: Math.min(...values).toFixed(4),
        max: Math.max(...values).toFixed(4)
      };
    });

    console.log(`${debugPrefix} Distribution statistics:`, stats);

    // Check for degenerate distributions
    const stdDevs = [
      parseFloat(stats.x.stdDev),
      parseFloat(stats.y.stdDev),
      parseFloat(stats.z.stdDev)
    ];

    // Warning: Very low standard deviation on any axis
    stdDevs.forEach((stdDev, i) => {
      if (stdDev < 0.05) {
        console.warn(`${debugPrefix} ⚠️ Warning: Very low std dev on ${axes[i]} axis: ${stdDev.toFixed(4)}`);
      }
    });

    // Error: Degenerate on all axes (all points clustered)
    if (stdDevs.every(s => s < 0.01)) {
      throw new Error('Degenerate coordinate distribution: All points are too clustered (std dev < 0.01 on all axes)');
    }
  }

  /**
   * Get fast mode configuration (optimized for speed over quality)
   * @returns {Object} - Fast mode UMAP configuration
   */
  static getFastModeConfig() {
    return {
      nComponents: 3,
      nNeighbors: 8, // Reduced from 15
      minDist: 0.05, // Reduced from 0.1
      metric: 'cosine',
      randomState: UMAP_RANDOM_SEED
    };
  }

  /**
   * Get quality mode configuration (optimized for quality over speed)
   * @returns {Object} - Quality mode UMAP configuration
   */
  static getQualityModeConfig() {
    return {
      nComponents: 3,
      nNeighbors: 20, // Increased from 15
      minDist: 0.15, // Increased from 0.1
      metric: 'cosine',
      randomState: UMAP_RANDOM_SEED
    };
  }
}

module.exports = UmapProjector;

