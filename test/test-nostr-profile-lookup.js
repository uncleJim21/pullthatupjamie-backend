#!/usr/bin/env node

/**
 * Test script for Nostr profile lookup functionality
 * Tests the NostrService profile lookup capabilities
 */

const NostrService = require('../utils/NostrService');

async function testNostrProfileLookup() {
    console.log('🧪 Testing Nostr Profile Lookup Functionality\n');
    
    const nostrService = new NostrService();
    
    // Test 1: npub validation
    console.log('1️⃣ Testing npub validation...');
    const validNpub = 'npub1cj8znuztfqkvq89pl8hceph0svvvqk0qay6nydgk9uyq7fhpfsgsqwrz4u';
    const invalidNpub1 = 'npub123invalid';
    const invalidNpub2 = 'not_an_npub';
    
    console.log(`   Valid npub: ${nostrService.isValidNpub(validNpub) ? '✅' : '❌'}`);
    console.log(`   Invalid npub 1: ${!nostrService.isValidNpub(invalidNpub1) ? '✅' : '❌'}`);
    console.log(`   Invalid npub 2: ${!nostrService.isValidNpub(invalidNpub2) ? '✅' : '❌'}\n`);
    
    // Test 2: npub to hex conversion
    console.log('2️⃣ Testing npub to hex conversion...');
    try {
        const hexPubkey = nostrService.npubToHex(validNpub);
        console.log(`   Converted ${validNpub.substring(0, 20)}... to hex: ${hexPubkey.substring(0, 16)}... ✅\n`);
    } catch (error) {
        console.log(`   Conversion failed: ${error.message} ❌\n`);
    }

    // Test 2.5: nprofile generation
    console.log('2️⃣.5️⃣ Testing nprofile generation...');
    try {
        const testRelays = ['wss://relay.damus.io', 'wss://nos.lol'];
        const nprofile = nostrService.npubToNprofile(validNpub, testRelays);
        console.log(`   Generated nprofile: ${nprofile.substring(0, 30)}... ✅`);
        console.log(`   Length: ${nprofile.length} characters`);
        console.log(`   Starts with nprofile1: ${nprofile.startsWith('nprofile1') ? '✅' : '❌'}\n`);
    } catch (error) {
        console.log(`   nprofile generation failed: ${error.message} ❌\n`);
    }
    
    // Test 3: Profile lookup (this will try to connect to real relays)
    console.log('3️⃣ Testing profile lookup (connecting to live relays)...');
    console.log('   ⚠️  This test connects to real Nostr relays and may take several seconds');
    console.log('   ⚠️  If no profile is found, this is normal - not all npubs have metadata\n');
    
    try {
        const result = await nostrService.lookupProfile(validNpub);
        
        if (result.success && result.profile) {
            console.log('   ✅ Profile lookup successful!');
            console.log(`   📝 Name: ${result.profile.name || 'N/A'}`);
            console.log(`   📝 Display Name: ${result.profile.displayName || 'N/A'}`);
            console.log(`   📝 About: ${result.profile.about ? result.profile.about.substring(0, 100) + '...' : 'N/A'}`);
            console.log(`   📝 Picture: ${result.profile.picture ? 'Yes' : 'No'}`);
            console.log(`   🔗 npub: ${result.profile.npub ? result.profile.npub.substring(0, 20) + '...' : 'N/A'}`);
            console.log(`   🔗 nprofile: ${result.profile.nprofile ? result.profile.nprofile.substring(0, 30) + '...' : 'N/A'}`);
            console.log(`   📊 Stats: ${result.stats.successful}/${result.stats.total} relays successful`);
        } else {
            console.log('   ⚠️  Profile not found (this is normal for test npubs)');
            console.log(`   📊 Stats: ${result.stats.successful}/${result.stats.total} relays successful`);
            console.log(`   💬 Message: ${result.message}`);
        }
    } catch (error) {
        console.log(`   ❌ Profile lookup failed: ${error.message}`);
    }
    
    console.log('\n🎯 Test complete! The Nostr profile lookup functionality is ready.');
    console.log('\n📚 Available API endpoints:');
    console.log('   GET  /api/nostr/user/:npub - Lookup profile by npub');
    console.log('   POST /api/nostr/lookup-profile - Lookup with custom relays');
    console.log('   POST /api/mentions/pins/:pinId/link-nostr - Link pin to Nostr profile');
    console.log('   POST /api/mentions/pins/:pinId/unlink-nostr - Unlink pin from Nostr profile');
    console.log('   GET  /api/mentions/pins/:pinId/suggest-nostr - Get mapping suggestions');
}

// Run the test
testNostrProfileLookup().catch(console.error);
