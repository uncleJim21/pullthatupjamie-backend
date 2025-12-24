// Test script to reproduce potential entitlement rollover bug
// 1. Creates/updates a test Entitlement document similar to a real user
// 2. Generates a JWT for the test email
// 3. Calls the on-demand /checkEligibility endpoint with that JWT
// 4. Logs all relevant details so you can see if 0/0 is returned

require('dotenv').config();

const mongoose = require('mongoose');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { Entitlement } = require('../models/Entitlement');

// Configurable values
const MONGO_URI = process.env.MONGO_URI;
const CASCDR_AUTH_SECRET = process.env.CASCDR_AUTH_SECRET;

// Base URL for your backend server (can override via env if needed)
const BASE_URL = process.env.ON_DEMAND_BASE_URL || 'http://localhost:4111/api/on-demand';

// Test identity – does NOT touch the real user
const TEST_EMAIL = process.env.TEST_ENTITLEMENT_EMAIL || 'test-entitlement-rollover@example.com';

// Seed values modeled after the reported user, but for a test identity
// Adjust these dates if you want to simulate different rollover timings.
const PERIOD_LENGTH_DAYS = 30;

// By default, set periodStart to 40 days ago so it is definitely expired
// and will trigger the rollover path when checkEntitlementEligibility runs.
function getExpiredPeriodStart() {
  const d = new Date();
  d.setDate(d.getDate() - 40);
  return d;
}

async function connectMongo() {
  if (!MONGO_URI) {
    throw new Error('MONGO_URI is not set in the environment');
  }

  console.log('📦 Connecting to MongoDB for rollover test...');
  await mongoose.connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  console.log('✅ Connected to MongoDB');
}

async function seedTestEntitlement() {
  console.log('\n=== Seeding Test Entitlement Document ===');

  const periodStart = getExpiredPeriodStart();
  const nextResetDate = new Date(periodStart);
  nextResetDate.setDate(nextResetDate.getDate() + PERIOD_LENGTH_DAYS);

  const seedData = {
    identifier: TEST_EMAIL,
    identifierType: 'jwt',
    entitlementType: 'onDemandRun',
    usedCount: 2,
    maxUsage: 8,
    periodStart,
    periodLengthDays: PERIOD_LENGTH_DAYS,
    nextResetDate,
    lastUsed: periodStart,
    status: 'active',
    metadata: {},
  };

  console.log('Using seed data:');
  console.log(
    JSON.stringify(
      {
        ...seedData,
        periodStart: periodStart.toISOString(),
        nextResetDate: nextResetDate.toISOString(),
      },
      null,
      2
    )
  );

  const entitlement = await Entitlement.findOneAndUpdate(
    {
      identifier: TEST_EMAIL,
      identifierType: 'jwt',
      entitlementType: 'onDemandRun',
    },
    seedData,
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    }
  );

  console.log('\nStored entitlement document in MongoDB:');
  console.log(
    JSON.stringify(
      {
        _id: entitlement._id,
        identifier: entitlement.identifier,
        identifierType: entitlement.identifierType,
        entitlementType: entitlement.entitlementType,
        usedCount: entitlement.usedCount,
        maxUsage: entitlement.maxUsage,
        periodStart: entitlement.periodStart,
        periodLengthDays: entitlement.periodLengthDays,
        nextResetDate: entitlement.nextResetDate,
        lastUsed: entitlement.lastUsed,
        status: entitlement.status,
        remainingUsage: entitlement.remainingUsage,
        daysUntilReset: entitlement.daysUntilReset,
      },
      null,
      2
    )
  );

  return entitlement;
}

function generateTestJwt() {
  console.log('\n=== Generating Test JWT ===');

  if (!CASCDR_AUTH_SECRET) {
    throw new Error('CASCDR_AUTH_SECRET is not set in the environment');
  }

  const payload = {
    email: TEST_EMAIL,
  };

  const token = jwt.sign(payload, CASCDR_AUTH_SECRET, {
    expiresIn: '1h',
  });

  console.log('Created JWT payload:', JSON.stringify(payload, null, 2));
  console.log('JWT length:', token.length);

  return token;
}

async function callCheckEligibility(jwtToken) {
  console.log('\n=== Calling /api/on-demand/checkEligibility with JWT ===');
  console.log('Base URL:', BASE_URL);

  try {
    const response = await axios.get(`${BASE_URL}/checkEligibility`, {
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
      },
    });

    console.log('\n✅ Eligibility endpoint responded:');
    console.log(JSON.stringify(response.data, null, 2));

    const eligibility = response.data?.eligibility || {};

    console.log('\n=== Parsed Eligibility Summary ===');
    console.log(
      JSON.stringify(
        {
          success: response.data?.success,
          eligible: eligibility.eligible,
          remainingRuns: eligibility.remainingRuns,
          totalLimit: eligibility.totalLimit,
          usedThisPeriod: eligibility.usedThisPeriod,
          periodStart: eligibility.periodStart,
          nextResetDate: eligibility.nextResetDate,
          daysUntilReset: eligibility.daysUntilReset,
          message: response.data?.message,
          rawError: eligibility.error,
        },
        null,
        2
      )
    );

    if (eligibility.totalLimit === 0 && eligibility.remainingRuns === 0) {
      console.log(
        '\n⚠️  Detected potential rollover bug: API returned 0/0 (totalLimit/remainingRuns) while entitlement exists in DB.'
      );
    } else {
      console.log('\nℹ️  API did not return 0/0 for this test entitlement.');
    }
  } catch (error) {
    console.error('\n❌ Error calling eligibility endpoint:');
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Response body:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.error('Error message:', error.message);
    }
  }
}

async function main() {
  try {
    await connectMongo();

    const entitlement = await seedTestEntitlement();

    // Quick local check: whether this period is expired according to the same logic as the server
    const now = new Date();
    const periodEnd = new Date(entitlement.periodStart);
    periodEnd.setDate(periodEnd.getDate() + entitlement.periodLengthDays);
    const isExpired = now >= periodEnd;

    console.log('\n=== Local Expiration Check ===');
    console.log(
      JSON.stringify(
        {
          now: now.toISOString(),
          periodStart: entitlement.periodStart.toISOString(),
          periodEnd: periodEnd.toISOString(),
          periodLengthDays: entitlement.periodLengthDays,
          isExpired,
        },
        null,
        2
      )
    );

    const token = generateTestJwt();

    await callCheckEligibility(token);
  } catch (err) {
    console.error('\n❌ Test script failed:', err.message);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔚 Closed MongoDB connection. Exiting.');
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

