const mongoose = require('mongoose');
require('dotenv').config();

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const { User } = require('../models/shared/UserSchema');

async function clearAllPins() {
  try {
    console.log('Connecting to database...');
    await mongoose.connection.asPromise();
    console.log('Connected to database');

    // Find all users and clear their pins
    const result = await User.updateMany(
      {},
      { 
        $set: { 
          'mention_preferences.pinned_mentions': [],
          'mentionPreferences.personalPins': [] // Also clear old structure
        } 
      }
    );

    console.log(`Updated ${result.modifiedCount} users`);
    console.log('All pins have been cleared!');

    // Verify the cleanup
    const usersWithPins = await User.find({
      $or: [
        { 'mention_preferences.pinned_mentions': { $exists: true, $ne: [] } },
        { 'mentionPreferences.personalPins': { $exists: true, $ne: [] } }
      ]
    });

    console.log(`Users still with pins: ${usersWithPins.length}`);

  } catch (error) {
    console.error('Error clearing pins:', error);
  } finally {
    await mongoose.connection.close();
    console.log('Database connection closed');
  }
}

clearAllPins(); 