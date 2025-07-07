# Frontend Specifications & Guidelines
## Cross-Platform Mention Mapping System

### Table of Contents
1. [Authentication & API Integration](#authentication--api-integration)
2. [Personal Pin Management UI](#personal-pin-management-ui)
3. [Search & Discovery Interface](#search--discovery-interface)
4. [Cross-Platform Adoption Flow](#cross-platform-adoption-flow)
5. [Component Architecture](#component-architecture)
6. [State Management](#state-management)
7. [Error Handling & UX](#error-handling--ux)
8. [Performance Considerations](#performance-considerations)

---

## Authentication & API Integration

### API Base Configuration
```javascript
const API_BASE = '/api/mentions';
const AUTH_HEADER = 'Authorization';
const TOKEN_PREFIX = 'Bearer ';
```

### Authentication Flow
1. **Token Storage**: Store JWT token in secure storage (httpOnly cookies preferred)
2. **Request Interceptor**: Automatically add `Authorization: Bearer <token>` to all mention API requests
3. **Token Refresh**: Implement automatic token refresh on 401 responses
4. **Fallback Auth**: Support development bypass mode (`BYPASS_PODCAST_ADMIN_AUTH=bypass`)

### API Error Handling
```javascript
// Standard error response format
{
  error: 'Error type',
  details: 'Detailed error message',
  code?: 'ERROR_CODE' // Optional error code
}

// HTTP Status Codes
200: Success
201: Created
400: Bad Request (validation errors)
401: Unauthorized (authentication required)
403: Forbidden (insufficient permissions)
404: Not Found
500: Internal Server Error
```

---

## Personal Pin Management UI

### Pin Management Dashboard
**Location**: `/mentions/pins` or integrated into user settings

**Features Required:**
- List all personal pins with platform icons
- Create new pin with form validation
- Edit existing pins inline or modal
- Delete pins with confirmation
- Search/filter pins by platform
- Sort by creation date, usage count, or platform

### Pin Card Component
```typescript
interface PersonalPin {
  id: string;
  platform: string;        // 'twitter', 'nostr', etc.
  username: string;        // Original username
  targetPlatform: string;  // Target platform
  targetUsername: string;  // Target username
  notes?: string;          // User notes
  createdAt: Date;
  updatedAt: Date;
  usageCount: number;      // How many times used
}
```

**Visual Design:**
- Platform icons (Twitter bird, Nostr lightning, etc.)
- Username display with platform context
- Usage count badge
- Quick edit/delete actions
- Notes preview (truncated if long)

### Create/Edit Pin Form
**Required Fields:**
- Source Platform (dropdown: Twitter, Nostr, etc.)
- Source Username (text input with validation)
- Target Platform (dropdown)
- Target Username (text input with validation)
- Notes (optional textarea)

**Validation Rules:**
- All platform/username combinations must be unique per user
- Usernames: alphanumeric, underscores, hyphens only
- Platform names: lowercase, no spaces
- Notes: max 500 characters

**UX Guidelines:**
- Auto-save drafts for long forms
- Real-time validation feedback
- Platform-specific username format hints
- Confirmation before overwriting existing pins

---

## Search & Discovery Interface

### Search Component
**Location**: Integrated into content creation flows

**Search Input:**
- Autocomplete with recent searches
- Platform-specific search suggestions
- Real-time results as user types
- Loading states and error handling

**Search Results Display:**
```typescript
interface SearchResult {
  type: 'twitter_user' | 'nostr_user' | 'cross_mapping' | 'personal_pin';
  platform: string;
  username: string;
  displayName?: string;
  avatar?: string;
  confidence?: number;     // 0-100 for cross-mappings
  targetPlatform?: string;
  targetUsername?: string;
  isPersonalPin?: boolean;
  usageCount?: number;
}
```

**Result Card Features:**
- Platform icon and username
- Confidence score indicator (for cross-mappings)
- Quick "Use This" button
- "Add to Pins" option
- "View Details" for more info

### Search Filters
- Platform filter (Twitter, Nostr, All)
- Result type filter (Users, Mappings, Personal Pins)
- Confidence threshold slider (for cross-mappings)
- Sort by relevance, confidence, or usage

---

## Cross-Platform Adoption Flow

### Adoption Modal/Flow
**Trigger**: "Adopt Mapping" button on cross-platform search results

**Adoption Process:**
1. **Preview**: Show mapping details and confidence score
2. **Customization**: Allow user to modify target username/notes
3. **Confirmation**: Review changes before adoption
4. **Success**: Show adoption confirmation with usage tips

**Adoption Form Fields:**
- Target Username (pre-filled, editable)
- Personal Notes (optional)
- Usage Preferences (auto-use, ask first, etc.)

### Adoption History
**Location**: `/mentions/adoptions` or user dashboard

**Display:**
- List of adopted mappings with adoption date
- Original confidence score
- Personal modifications made
- Usage statistics
- Option to "unadopt" (remove from personal pins)

---

## Component Architecture

### Core Components
```typescript
// Search Components
<MentionSearch />
<SearchResults />
<SearchResultCard />
<SearchFilters />

// Pin Management
<PinDashboard />
<PinCard />
<PinForm />
<PinList />

// Cross-Platform
<AdoptionModal />
<AdoptionHistory />
<ConfidenceIndicator />

// Shared
<PlatformIcon />
<LoadingSpinner />
<ErrorBoundary />
<ConfirmationDialog />
```

### Component Hierarchy
```
App
├── Router
│   ├── MentionSearch (main search)
│   ├── PinDashboard (pin management)
│   └── AdoptionHistory (adoption tracking)
├── Shared Components
│   ├── PlatformIcon
│   ├── LoadingSpinner
│   └── ErrorBoundary
└── Modals
    ├── PinForm
    ├── AdoptionModal
    └── ConfirmationDialog
```

---

## State Management

### Global State Structure
```typescript
interface MentionState {
  // Search state
  searchQuery: string;
  searchResults: SearchResult[];
  searchFilters: SearchFilters;
  isLoading: boolean;
  
  // Personal pins
  personalPins: PersonalPin[];
  pinsLoading: boolean;
  
  // Cross-platform mappings
  adoptedMappings: AdoptedMapping[];
  
  // UI state
  activeModal: string | null;
  selectedPin: PersonalPin | null;
  error: string | null;
}
```

### State Management Guidelines
1. **Use React Context** for global state (pins, user preferences)
2. **Local state** for component-specific data (form inputs, UI toggles)
3. **Optimistic updates** for better UX (update UI before API response)
4. **Cache management** for search results and pin data
5. **Error boundaries** for graceful error handling

### API Integration Patterns
```javascript
// Custom hooks for API calls
const usePersonalPins = () => {
  const [pins, setPins] = useState([]);
  const [loading, setLoading] = useState(false);
  
  const fetchPins = async () => { /* API call */ };
  const createPin = async (pinData) => { /* API call */ };
  const updatePin = async (id, updates) => { /* API call */ };
  const deletePin = async (id) => { /* API call */ };
  
  return { pins, loading, fetchPins, createPin, updatePin, deletePin };
};
```

---

## Error Handling & UX

### Error Types & Handling
1. **Authentication Errors (401)**
   - Redirect to login
   - Show re-authentication modal
   - Clear invalid tokens

2. **Validation Errors (400)**
   - Show field-specific error messages
   - Highlight invalid fields
   - Provide correction suggestions

3. **Network Errors**
   - Retry mechanism with exponential backoff
   - Offline mode indicators
   - Queue failed operations for retry

4. **Server Errors (500)**
   - Show user-friendly error message
   - Provide retry option
   - Log error details for debugging

### Loading States
- **Skeleton loaders** for content areas
- **Spinner overlays** for modal operations
- **Progress indicators** for bulk operations
- **Optimistic UI updates** where possible

### Success Feedback
- **Toast notifications** for successful operations
- **Visual feedback** (checkmarks, color changes)
- **Undo options** for destructive actions
- **Confirmation messages** for important changes

---

## Performance Considerations

### Optimization Strategies
1. **Debounced search** (300ms delay)
2. **Virtualized lists** for large pin collections
3. **Lazy loading** for adoption history
4. **Memoization** of expensive components
5. **Code splitting** for route-based components

### Caching Strategy
```javascript
// Cache configuration
const CACHE_CONFIG = {
  searchResults: { ttl: 5 * 60 * 1000 }, // 5 minutes
  personalPins: { ttl: 10 * 60 * 1000 }, // 10 minutes
  userProfile: { ttl: 30 * 60 * 1000 },  // 30 minutes
};
```

### Bundle Optimization
- **Tree shaking** for unused components
- **Dynamic imports** for heavy features
- **Image optimization** for platform icons
- **CSS-in-JS** for component-specific styles

---

## Development Guidelines

### Code Standards
1. **TypeScript** for all new components
2. **ESLint + Prettier** for code formatting
3. **Component testing** with React Testing Library
4. **Accessibility** compliance (WCAG 2.1 AA)
5. **Mobile-first** responsive design

### Testing Strategy
```javascript
// Component testing examples
describe('PinCard', () => {
  it('displays pin information correctly');
  it('handles edit button click');
  it('shows delete confirmation');
  it('displays usage count badge');
});

describe('MentionSearch', () => {
  it('debounces search input');
  it('displays loading state');
  it('handles API errors gracefully');
  it('filters results correctly');
});
```

### Accessibility Requirements
- **Keyboard navigation** for all interactive elements
- **Screen reader** support with ARIA labels
- **Color contrast** compliance (4.5:1 minimum)
- **Focus management** for modals and forms
- **Error announcements** for form validation

---

## Integration Checklist

### Phase 1 Integration (Current)
- [ ] Set up authentication middleware integration
- [ ] Implement personal pin CRUD operations
- [ ] Create pin management dashboard
- [ ] Add search integration with personal pins
- [ ] Test all API endpoints

### Phase 2 Integration (Future)
- [ ] Implement cross-platform adoption flow
- [ ] Add public mapping discovery
- [ ] Create adoption history tracking
- [ ] Implement confidence scoring display

### Phase 3 Integration (Future)
- [ ] Add performance optimizations
- [ ] Implement advanced caching
- [ ] Create admin dashboard
- [ ] Add analytics and reporting

---

## API Endpoints Reference

### Personal Pins
- `GET /api/mentions/pins` - Fetch user's personal pins
- `POST /api/mentions/pins` - Create/update personal pin
- `PUT /api/mentions/pins/:pinId` - Update specific pin
- `DELETE /api/mentions/pins/:pinId` - Delete personal pin

### Search
- `POST /api/mentions/search` - Search mentions across platforms

### Future Endpoints
- `POST /api/mentions/adopt` - Adopt public mapping
- `GET /api/mentions/public` - Discover public mappings
- `POST /api/mentions/create` - Create public mapping
- `GET /api/mentions/analytics` - Usage analytics 