# 🛠️ Pull That Up Jamie Back End  
### 🌐 Comprehensive Content Discovery & Media Processing Platform for [Pull That Up Jamie](https://github.com/uncleJim21/pullthatupjamie-react/tree/jc/prep-for-open-source)

---

## 🔑 **What Does It Do?**  
This backend server powers **Pull That Up Jamie**, a sophisticated content discovery and media processing platform that combines privacy-focused web search, AI-powered podcast intelligence, and advanced video clip generation capabilities.

---

## ✨ **Core Features**

### 🔍 **AI-Powered Search & Research**
- **Privacy-First Web Search:** Integrates with SEARXNG for anonymous web searching
- **Streaming AI Responses:** Real-time responses from both OpenAI GPT and Anthropic Claude models
- **Smart Citation System:** Inline source citations with [[n]](url) format
- **Multiple Search Modes:** Quick summaries or detailed research with configurable preferences

### 🎙️ **Podcast Intelligence System**
- **Semantic Podcast Search:** Vector-based search using OpenAI embeddings and Pinecone database
- **Transcript Processing:** Advanced transcript analysis with word-level timestamps
- **Episode & Feed Management:** Comprehensive metadata retrieval and feed caching
- **Content Discovery:** Find semantically similar discussions across thousands of podcast episodes

### 🎬 **Advanced Video Clip Generation**
- **Automated Clip Creation:** Generate short-form videos from podcast segments
- **Real-Time Subtitle Generation:** Word-level subtitle timing from transcript data
- **Queue Management:** Concurrent processing with intelligent queue management
- **CDN Integration:** Automatic upload to DigitalOcean Spaces with preview images
- **Social Media Optimization:** TikTok-style rendering with metadata for sharing

### 🔐 **Multi-Tier Authentication System**
- **⚡ BOLT11 Lightning Payments:** Anonymous micropayments for privacy-focused access
- **📧 Email Subscriptions:** Traditional account-based access via Square payment integration  
- **🆓 Free Tier:** IP-based eligibility with intelligent rate limiting
- **🛡️ JWT Authentication:** Secure token-based authentication for pro features

### 👑 **Pro Podcast Management**
- **Admin Dashboard:** Comprehensive podcast administrator features
- **File Upload Management:** Pre-signed URL generation for secure media uploads
- **Run History Tracking:** Detailed processing history and analytics
- **On-Demand Processing:** Scheduled and manual podcast processing with eligibility controls
- **User Preferences:** Customizable settings and notification preferences

### 🤖 **AI Content Assistant ("Jamie Assist")**
- **Promotional Content Generation:** AI-powered social media post creation
- **Context-Aware Writing:** Leverages podcast metadata and clip content
- **Streaming Responses:** Real-time content generation with user preferences
- **Social Media Optimization:** Hashtag-free, engagement-optimized content

---

## 🏗️ **Technical Infrastructure**

### 📊 **Data Management**
- **MongoDB Integration:** Robust data persistence with backup management
- **Vector Database:** Pinecone integration for semantic search capabilities
- **Feed Caching:** Intelligent caching system for podcast feed data
- **Database Backups:** Automated backup system with DigitalOcean Spaces

### ⚙️ **Processing & Scheduling**
- **Task Scheduler:** Chicago timezone-based scheduling for automated tasks
- **Queue Management:** Intelligent job queuing for resource-intensive operations
- **Transcript Processing:** Multiple retrieval methods (Spaces, HTTP fallbacks)
- **Error Handling:** Comprehensive error handling with detailed logging

### 🌐 **API & Integration**
- **RESTful API:** Comprehensive API with streaming capabilities
- **CORS Configuration:** Multi-origin support for frontend integration
- **Session Management:** Secure session handling with configurable cookies
- **Health Monitoring:** System status and performance monitoring endpoints

### 🔧 **Developer Features**
- **Debug Mode:** Comprehensive debugging tools and endpoints
- **Environment Configuration:** Flexible environment-based configuration
- **Rate Limiting:** Intelligent rate limiting with user-based controls
- **Logging System:** Detailed logging with timestamp-based debugging

---

## 🚀 **Why Use It?**  
- **🛡️ Privacy-First:** No invasive tracking, anonymous payment options, privacy-focused design
- **🎯 Intelligent Discovery:** AI-powered content discovery across web and podcast content  
- **⚡ High Performance:** Optimized for speed with concurrent processing and intelligent caching
- **🔌 Comprehensive Integration:** Seamless frontend integration with streaming capabilities
- **📱 Social Media Ready:** Built-in social media optimization and sharing features
- **🎨 Professional Grade:** Enterprise-level features for content creators and administrators

---

## 💻 **Built With:**  
- **Express.js:** High-performance server framework with streaming support
- **MongoDB:** Document database with Mongoose ODM
- **Pinecone:** Vector database for semantic search capabilities
- **OpenAI:** GPT models and embedding generation
- **Anthropic:** Claude AI models for advanced reasoning
- **DigitalOcean Spaces:** CDN and file storage infrastructure
- **Lightning Network:** Privacy-friendly micropayment processing
- **SEARXNG:** Privacy-focused metasearch engine integration

---

## 📡 **API Endpoints Overview**

### Search & Research
- `POST /api/stream-search` - AI-powered streaming search with citations
- `POST /api/search-quotes` - Semantic podcast content search
- `GET /api/check-free-eligibility` - Free tier eligibility checking

### Clip Generation & Management  
- `POST /api/make-clip` - Generate video clips with subtitles
- `GET /api/clip-status/:lookupHash` - Check clip processing status
- `GET /api/render-clip/:lookupHash` - Render clip with social media optimization
- `POST /api/jamie-assist/:lookupHash` - AI-powered promotional content generation

### Podcast Management
- `GET /api/get-available-feeds` - Retrieve cached podcast feeds
- `GET /api/podcast-feed/:feedId` - Get specific podcast feed data
- `GET /api/episode/:guid` - Retrieve episode metadata
- `POST /api/generate-presigned-url` - Secure file upload URLs

### Authentication & Payments
- `GET /invoice-pool` - Generate Lightning payment invoices
- `POST /register-sub` - Register subscription authentication
- `POST /api/validate-privs` - Validate user privileges

### System & Health
- `GET /health` - System health and status monitoring
- `GET /api/get-clip-count` - Platform usage statistics

---

**Start powering advanced content discovery and media processing with this comprehensive, privacy-focused platform!** 🚀
