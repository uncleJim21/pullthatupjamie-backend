# Frontend Implementation Guidelines
## Cross-Platform Mention Mapping System

### 🎯 Implementation Overview

This document provides comprehensive guidelines for frontend developers and AI assistants implementing the cross-platform mention mapping system. The system allows users to create, manage, and discover mappings between social media profiles across different platforms.

---

## 📋 Phase 1 Implementation Checklist

### ✅ Backend Ready (Completed)
- [x] Authentication middleware (`middleware/authMiddleware.js`)
- [x] Personal pin CRUD endpoints (`/api/mentions/pins`)
- [x] Search endpoint (`/api/mentions/search`)
- [x] User model with mention preferences
- [x] Social profile mappings model

### 🔄 Frontend Implementation Required
- [ ] Authentication integration
- [ ] Personal pin management UI
- [ ] Search interface with personal pin integration
- [ ] Error handling and loading states
- [ ] Testing and validation

---

## 🔐 Authentication Integration

### Setup Requirements
```javascript
// Required environment variables
CASCDR_AUTH_SECRET=your_jwt_secret
BYPASS_PODCAST_ADMIN_AUTH=bypass  // Development only
```

### Authentication Flow
1. **Token Storage**: Use httpOnly cookies or secure localStorage
2. **Request Headers**: Add `Authorization: Bearer <token>` to all API calls
3. **Error Handling**: Handle 401 responses with re-authentication
4. **Development Mode**: Support bypass authentication for testing

### Implementation Example
```javascript
// API client setup
const apiClient = {
  baseURL: '/api/mentions',
  
  async request(endpoint, options = {}) {
    const token = getAuthToken(); // Get from secure storage
    
    const config = {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options.headers
      },
      ...options
    };
    
    try {
      const response = await fetch(`${this.baseURL}${endpoint}`, config);
      
      if (response.status === 401) {
        // Handle authentication error
        handleAuthError();
        return;
      }
      
      return await response.json();
    } catch (error) {
      console.error('API request failed:', error);
      throw error;
    }
  }
};
```

---

## 📌 Personal Pin Management UI

### Core Components Needed

#### 1. Pin Dashboard (`/mentions/pins`)
```typescript
interface PinDashboardProps {
  onPinCreate: (pin: PersonalPin) => void;
  onPinUpdate: (id: string, updates: Partial<PersonalPin>) => void;
  onPinDelete: (id: string) => void;
}

// Features:
// - List all personal pins
// - Create new pin button
// - Search/filter pins
// - Sort options (date, usage, platform)
```

#### 2. Pin Card Component
```typescript
interface PinCardProps {
  pin: PersonalPin;
  onEdit: (pin: PersonalPin) => void;
  onDelete: (id: string) => void;
}

// Visual elements:
// - Platform icon (Twitter, Nostr, etc.)
// - Source username with platform context
// - Target username with platform context
// - Usage count badge
// - Notes preview (truncated)
// - Edit/Delete action buttons
```

#### 3. Pin Form (Create/Edit)
```typescript
interface PinFormProps {
  pin?: PersonalPin; // undefined for create, existing pin for edit
  onSubmit: (pinData: PinFormData) => void;
  onCancel: () => void;
}

interface PinFormData {
  platform: string;
  username: string;
  targetPlatform: string;
  targetUsername: string;
  notes?: string;
}
```

### Form Validation Rules
```javascript
const validationRules = {
  platform: {
    required: true,
    pattern: /^[a-z]+$/, // lowercase only
    options: ['twitter', 'nostr', 'mastodon', 'bluesky']
  },
  username: {
    required: true,
    pattern: /^[a-zA-Z0-9_-]+$/, // alphanumeric, underscore, hyphen
    minLength: 1,
    maxLength: 50
  },
  targetPlatform: {
    required: true,
    pattern: /^[a-z]+$/,
    options: ['twitter', 'nostr', 'mastodon', 'bluesky']
  },
  targetUsername: {
    required: true,
    pattern: /^[a-zA-Z0-9_-]+$/,
    minLength: 1,
    maxLength: 50
  },
  notes: {
    maxLength: 500,
    optional: true
  }
};
```

### API Integration for Pins
```javascript
// Custom hook for pin management
const usePersonalPins = () => {
  const [pins, setPins] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchPins = async () => {
    setLoading(true);
    try {
      const response = await apiClient.request('/pins');
      setPins(response.pins);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const createPin = async (pinData) => {
    try {
      const response = await apiClient.request('/pins', {
        method: 'POST',
        body: JSON.stringify(pinData)
      });
      setPins(prev => [...prev, response.pin]);
      return response.pin;
    } catch (err) {
      setError(err.message);
      throw err;
    }
  };

  const updatePin = async (pinId, updates) => {
    try {
      const response = await apiClient.request(`/pins/${pinId}`, {
        method: 'PUT',
        body: JSON.stringify(updates)
      });
      setPins(prev => prev.map(pin => 
        pin.id === pinId ? response.pin : pin
      ));
      return response.pin;
    } catch (err) {
      setError(err.message);
      throw err;
    }
  };

  const deletePin = async (pinId) => {
    try {
      await apiClient.request(`/pins/${pinId}`, {
        method: 'DELETE'
      });
      setPins(prev => prev.filter(pin => pin.id !== pinId));
    } catch (err) {
      setError(err.message);
      throw err;
    }
  };

  return {
    pins,
    loading,
    error,
    fetchPins,
    createPin,
    updatePin,
    deletePin
  };
};
```

---

## 🔍 Search Interface Integration

### Search Component Requirements
```typescript
interface MentionSearchProps {
  onResultSelect: (result: SearchResult) => void;
  onPinAdd: (result: SearchResult) => void;
  initialQuery?: string;
}

interface SearchResult {
  type: 'twitter_user' | 'nostr_user' | 'cross_mapping' | 'personal_pin';
  platform: string;
  username: string;
  displayName?: string;
  avatar?: string;
  confidence?: number;
  targetPlatform?: string;
  targetUsername?: string;
  isPersonalPin?: boolean;
  usageCount?: number;
}
```

### Search Integration with Personal Pins
```javascript
// Enhanced search hook
const useMentionSearch = () => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const { pins } = usePersonalPins();

  const search = async (searchQuery) => {
    setLoading(true);
    try {
      const response = await apiClient.request('/search', {
        method: 'POST',
        body: JSON.stringify({ query: searchQuery })
      });
      
      // Enhance results with personal pin data
      const enhancedResults = response.results.map(result => ({
        ...result,
        isPersonalPin: pins.some(pin => 
          pin.platform === result.platform && 
          pin.username === result.username
        )
      }));
      
      setResults(enhancedResults);
    } catch (err) {
      console.error('Search failed:', err);
    } finally {
      setLoading(false);
    }
  };

  return { query, setQuery, results, loading, search };
};
```

---

## 🚀 Streaming Search Integration (New)

### Overview
The new `/api/mentions/search/stream` endpoint provides real-time search results using Server-Sent Events (SSE). This significantly improves perceived performance by delivering results as they become available from different sources.

### Performance Benefits
- **200-500ms faster perceived response time**
- **Personal pins appear immediately** (fastest source)
- **Twitter results stream in as API responds** (medium speed)
- **Cross-mappings follow when DB query completes** (slowest)
- **Individual source failures don't break entire search**

### Implementation Example

#### EventSource Setup
```javascript
// Custom hook for streaming search
const useStreamingSearch = () => {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [completedSources, setCompletedSources] = useState([]);
  const [error, setError] = useState(null);

  const streamSearch = async (query, options = {}) => {
    setLoading(true);
    setResults([]);
    setCompletedSources([]);
    setError(null);

    try {
      const response = await fetch('/api/mentions/search/stream', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${getAuthToken()}`,
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream'
        },
        body: JSON.stringify({
          query,
          platforms: options.platforms || ['twitter', 'nostr'],
          includePersonalPins: options.includePersonalPins ?? true,
          includeCrossPlatformMappings: options.includeCrossPlatformMappings ?? true,
          limit: options.limit || 10
        })
      });

      if (!response.ok) {
        throw new Error(`Search failed: ${response.statusText}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              handleStreamEvent(data);
            } catch (e) {
              console.warn('Failed to parse SSE data:', line);
            }
          }
        }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleStreamEvent = (data) => {
    switch (data.type) {
      case 'partial':
        // Add results from this source
        setResults(prev => {
          // For pins, just append
          if (data.source === 'pins') {
            return [...prev, ...data.results];
          }
          
          // For Twitter, merge with existing pins data
          if (data.source === 'twitter') {
            const updatedResults = [...prev];
            data.results.forEach(twitterResult => {
              const existingIndex = updatedResults.findIndex(r => 
                r.platform === twitterResult.platform && 
                r.username.toLowerCase() === twitterResult.username.toLowerCase()
              );
              
              if (existingIndex >= 0) {
                // Update existing result with Twitter data
                updatedResults[existingIndex] = twitterResult;
              } else {
                // Add new result
                updatedResults.push(twitterResult);
              }
            });
            return updatedResults;
          }
          
          // For mappings, just append
          return [...prev, ...data.results];
        });
        
        setCompletedSources(data.meta.completedSources);
        break;
        
      case 'complete':
        setLoading(false);
        setCompletedSources(data.completedSources);
        break;
        
      case 'error':
        console.error(`Search error from ${data.source}:`, data.error);
        setCompletedSources(data.completedSources);
        break;
    }
  };

  return { 
    results, 
    loading, 
    completedSources, 
    error, 
    streamSearch 
  };
};
```

#### React Component Integration
```jsx
// StreamingSearchComponent.jsx
import { useState, useCallback } from 'react';
import { useStreamingSearch } from '../hooks/useStreamingSearch';
import { debounce } from 'lodash';

export function StreamingSearchComponent() {
  const [query, setQuery] = useState('');
  const { results, loading, completedSources, error, streamSearch } = useStreamingSearch();

  // Debounced search function
  const debouncedSearch = useCallback(
    debounce((searchQuery) => {
      if (searchQuery.trim()) {
        streamSearch(searchQuery);
      }
    }, 300),
    [streamSearch]
  );

  const handleQueryChange = (newQuery) => {
    setQuery(newQuery);
    debouncedSearch(newQuery);
  };

  return (
    <div className="streaming-search">
      <input
        type="text"
        value={query}
        onChange={(e) => handleQueryChange(e.target.value)}
        placeholder="Search mentions..."
        className="search-input"
      />
      
      {loading && (
        <div className="search-progress">
          <span>Searching...</span>
          <div className="source-indicators">
            {completedSources.includes('pins') && <span>📌 Pins ✓</span>}
            {completedSources.includes('twitter') && <span>🐦 Twitter ✓</span>}
            {completedSources.includes('mappings') && <span>🔗 Mappings ✓</span>}
          </div>
        </div>
      )}
      
      {error && (
        <div className="search-error">
          Error: {error}
        </div>
      )}
      
      <div className="search-results">
        {results.map((result, index) => (
          <SearchResultCard 
            key={`${result.platform}-${result.username}-${index}`}
            result={result}
            isStreaming={loading}
          />
        ))}
      </div>
    </div>
  );
}
```

### Streaming vs Regular Search

#### When to Use Streaming Search
- **Interactive search interfaces** (search-as-you-type)
- **User-facing search pages** where speed matters
- **When personal pins are important** (they show immediately)
- **Large result sets** where partial loading helps UX

#### When to Use Regular Search
- **Background/automated searches**
- **Simple one-off lookups**
- **When you need all results at once**
- **Integration with non-streaming systems**

### Error Handling for Streaming
```javascript
const handleStreamError = (error, source) => {
  // Individual source failures don't break the entire search
  console.warn(`Search source ${source} failed:`, error);
  
  // Show user which sources failed
  setSourceErrors(prev => ({
    ...prev,
    [source]: error
  }));
  
  // Continue with other sources
};

// Display partial errors to user
{sourceErrors.twitter && (
  <div className="source-warning">
    Twitter search temporarily unavailable
  </div>
)}
```

### Performance Optimization for Streaming
```javascript
// Optimize result updates with useMemo
const optimizedResults = useMemo(() => {
  return results.filter(result => {
    // Filter logic here
    return result.platform === selectedPlatform || selectedPlatform === 'all';
  });
}, [results, selectedPlatform]);

// Virtualize large result lists
import { FixedSizeList as List } from 'react-window';

const VirtualizedResults = ({ results }) => (
  <List
    height={400}
    itemCount={results.length}
    itemSize={80}
    itemData={results}
  >
    {({ index, style, data }) => (
      <div style={style}>
        <SearchResultCard result={data[index]} />
      </div>
    )}
  </List>
);
```

---

## 🎨 UI/UX Guidelines

### Design System Requirements
```css
/* Color palette */
:root {
  --primary-color: #1da1f2;      /* Twitter blue */
  --secondary-color: #ff6b35;    /* Nostr orange */
  --success-color: #28a745;
  --warning-color: #ffc107;
  --error-color: #dc3545;
  --text-primary: #212529;
  --text-secondary: #6c757d;
  --background-light: #f8f9fa;
  --border-color: #dee2e6;
}

/* Platform-specific colors */
.platform-twitter { color: var(--primary-color); }
.platform-nostr { color: var(--secondary-color); }
.platform-mastodon { color: #6364ff; }
.platform-bluesky { color: #0085ff; }
```

### Component Styling Guidelines
1. **Consistent spacing**: Use 8px grid system
2. **Typography**: Clear hierarchy with readable fonts
3. **Interactive states**: Hover, focus, active states for all clickable elements
4. **Loading states**: Skeleton loaders and spinners
5. **Error states**: Clear error messages with recovery options

### Accessibility Requirements
```javascript
// ARIA labels and roles
<button 
  aria-label="Edit pin for @username on Twitter"
  role="button"
  onClick={handleEdit}
>
  Edit
</button>

// Keyboard navigation
const handleKeyDown = (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    handleAction();
  }
};
```

---

## 🧪 Testing Strategy

### Unit Tests Required
```javascript
// Component tests
describe('PinCard', () => {
  it('renders pin information correctly');
  it('handles edit button click');
  it('shows delete confirmation dialog');
  it('displays usage count badge');
  it('truncates long notes appropriately');
});

describe('PinForm', () => {
  it('validates required fields');
  it('shows platform-specific validation errors');
  it('handles form submission correctly');
  it('pre-fills form for edit mode');
});

describe('MentionSearch', () => {
  it('debounces search input');
  it('displays loading state during search');
  it('handles API errors gracefully');
  it('highlights personal pins in results');
});
```

### Integration Tests
```javascript
// API integration tests
describe('Personal Pins API', () => {
  it('creates new pin successfully');
  it('updates existing pin');
  it('deletes pin with confirmation');
  it('handles validation errors');
  it('requires authentication');
});
```

---

## 🚀 Performance Optimization

### Implementation Priorities
1. **Debounced search** (300ms delay)
2. **Virtualized lists** for large pin collections
3. **Optimistic updates** for better UX
4. **Error boundaries** for graceful failures
5. **Lazy loading** for non-critical components

### Caching Strategy
```javascript
// Cache configuration
const cacheConfig = {
  pins: { ttl: 10 * 60 * 1000 },      // 10 minutes
  searchResults: { ttl: 5 * 60 * 1000 }, // 5 minutes
  userProfile: { ttl: 30 * 60 * 1000 }   // 30 minutes
};

// Cache implementation
const useCache = (key, ttl) => {
  const [data, setData] = useState(null);
  
  const getCached = () => {
    const cached = localStorage.getItem(key);
    if (cached) {
      const { value, timestamp } = JSON.parse(cached);
      if (Date.now() - timestamp < ttl) {
        return value;
      }
    }
    return null;
  };
  
  const setCached = (value) => {
    localStorage.setItem(key, JSON.stringify({
      value,
      timestamp: Date.now()
    }));
    setData(value);
  };
  
  return { data, getCached, setCached };
};
```

---

## 📱 Mobile Responsiveness

### Breakpoint Strategy
```css
/* Mobile-first approach */
.container {
  padding: 16px;
  max-width: 100%;
}

/* Tablet */
@media (min-width: 768px) {
  .container {
    padding: 24px;
    max-width: 720px;
  }
}

/* Desktop */
@media (min-width: 1024px) {
  .container {
    padding: 32px;
    max-width: 960px;
  }
}
```

### Touch-Friendly Interactions
```css
/* Minimum touch target size */
button, .clickable {
  min-height: 44px;
  min-width: 44px;
  padding: 12px 16px;
}

/* Touch feedback */
.clickable:active {
  transform: scale(0.98);
  transition: transform 0.1s ease;
}
```

---

## 🔧 Development Setup

### Required Dependencies
```json
{
  "dependencies": {
    "react": "^18.0.0",
    "react-dom": "^18.0.0",
    "react-router-dom": "^6.0.0",
    "axios": "^1.0.0",
    "lodash.debounce": "^4.0.8"
  },
  "devDependencies": {
    "@testing-library/react": "^13.0.0",
    "@testing-library/jest-dom": "^5.16.0",
    "eslint": "^8.0.0",
    "prettier": "^2.8.0"
  }
}
```

### Environment Configuration
```javascript
// .env.local
REACT_APP_API_BASE_URL=http://localhost:3000
REACT_APP_AUTH_ENABLED=true
REACT_APP_DEBUG_MODE=true
```

---

## 📊 Success Metrics

### Implementation Success Criteria
- [ ] All CRUD operations work without errors
- [ ] Search integrates personal pins correctly
- [ ] Authentication flows work seamlessly
- [ ] Mobile responsiveness meets requirements
- [ ] Accessibility compliance achieved
- [ ] Performance benchmarks met
- [ ] Error handling covers all scenarios

### User Experience Goals
- **Task completion rate**: >95% for pin creation
- **Search response time**: <500ms for results
- **Error recovery rate**: >90% for validation errors
- **Mobile usability score**: >85 on Lighthouse

---

## 🆘 Support & Troubleshooting

### Common Issues
1. **Authentication failures**: Check token storage and API headers
2. **CORS errors**: Verify API endpoint configuration
3. **Validation errors**: Review form validation rules
4. **Performance issues**: Implement caching and debouncing

### Debug Tools
```javascript
// Development debugging
const DEBUG = process.env.NODE_ENV === 'development';

const debugLog = (message, data) => {
  if (DEBUG) {
    console.log(`[Mentions Debug] ${message}`, data);
  }
};

// API request logging
const logApiRequest = (endpoint, options) => {
  debugLog('API Request', { endpoint, options });
};
```

---

## 📞 Next Steps

### Immediate Actions
1. Set up authentication integration
2. Create basic pin management UI
3. Implement search with personal pin integration
4. Add error handling and loading states
5. Test all functionality

### Future Enhancements
1. Cross-platform adoption flow
2. Public mapping discovery
3. Advanced analytics
4. Performance optimizations
5. Mobile app integration

---

*This document should be updated as the implementation progresses and new requirements are identified.* 