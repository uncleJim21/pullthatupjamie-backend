// Add these lines after the existing routes in server.js around line 1649:
app.use('/api/social', socialPostRoutes);
app.use('/api/nostr', nostrRoutes);

// And add SocialPostProcessor after other services start around line 148:
const SocialPostProcessor = require('./utils/SocialPostProcessor');
const socialProcessor = new SocialPostProcessor();
socialProcessor.start();
console.log('🚀 Social post processor started');

