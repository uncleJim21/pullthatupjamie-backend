const express = require('express');
const WebSocket = require('ws');
const crypto = require('crypto');
const router = express.Router();
const { validatePrivs } = require('../middleware/validate-privs');

// Define relay pool for Nostr (same as your React component)
const DEFAULT_RELAYS = [
    "wss://relay.primal.net",
    "wss://relay.damus.io", 
    "wss://nos.lol",

    // Expanded defaults (normalized, deduped) for broader publishing reach
    "wss://eden.nostr.land",
    "wss://atlas.nostr.land",
    "wss://cyberspace.nostr1.com",
    "wss://nostr.lopp.social",
    "wss://nostr.czas.plus",
    "wss://premium.primal.net",
    "wss://relay.artio.inf.unibe.ch",
    "wss://relay-rpi.edufeed.org",
    "wss://relay.nosto.re",
    "wss://nostr.oxtr.dev",
    "wss://njump.me",
    "wss://espelho.girino.org",

    // Keep these legacy defaults too (still common in the ecosystem)
    "wss://relay.mostr.pub",
    "wss://nostr.land",
    "wss://purplerelay.com",
    "wss://relay.snort.social"
];

// Bech32 encoding for nevent creation (simplified version)
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

const polymod = (values) => {
    let chk = 1;
    for (let value of values) {
        const top = chk >> 25;
        chk = (chk & 0x1ffffff) << 5 ^ value;
        for (let i = 0; i < 5; i++) {
            if ((top >> i) & 1) {
                chk ^= GENERATOR[i];
            }
        }
    }
    return chk;
};

const hrpExpand = (hrp) => {
    const result = [];
    for (let i = 0; i < hrp.length; i++) {
        result.push(hrp.charCodeAt(i) >> 5);
    }
    result.push(0);
    for (let i = 0; i < hrp.length; i++) {
        result.push(hrp.charCodeAt(i) & 31);
    }
    return result;
};

const hexToBytes = (hex) => {
    const result = [];
    for (let i = 0; i < hex.length; i += 2) {
        result.push(parseInt(hex.slice(i, i + 2), 16));
    }
    return result;
};

const convertBits = (data, fromBits, toBits, pad) => {
    let acc = 0;
    let bits = 0;
    const result = [];
    const maxv = (1 << toBits) - 1;

    for (const value of data) {
        if (value < 0 || (value >> fromBits) !== 0) {
            throw new Error('Invalid value');
        }
        acc = (acc << fromBits) | value;
        bits += fromBits;
        while (bits >= toBits) {
            bits -= toBits;
            result.push((acc >> bits) & maxv);
        }
    }

    if (pad) {
        if (bits > 0) {
            result.push((acc << (toBits - bits)) & maxv);
        }
    } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
        throw new Error('Invalid padding');
    }

    return result;
};

const encodeBech32 = (prefix, data) => {
    try {
        // Convert event ID to bytes
        const eventIdBytes = hexToBytes(data);

        // Create TLV data
        const tlv = [0, 32, ...eventIdBytes]; // type 0, length 32, followed by event ID

        // Convert to 5-bit array
        const words = convertBits(tlv, 8, 5, true);

        // Calculate checksum
        const hrpExpanded = hrpExpand(prefix);
        const values = [...hrpExpanded, ...words];
        const polymodValue = polymod([...values, 0, 0, 0, 0, 0, 0]) ^ 1;
        const checksumWords = [];
        for (let i = 0; i < 6; i++) {
            checksumWords.push((polymodValue >> 5 * (5 - i)) & 31);
        }

        // Combine everything
        return prefix + '1' + 
               words.map(i => CHARSET.charAt(i)).join('') + 
               checksumWords.map(i => CHARSET.charAt(i)).join('');
    } catch (error) {
        console.error('Error encoding bech32:', error);
        return null;
    }
};

// Connect to a single relay
const connectToRelay = (relayUrl, timeout = 10000) => {
    return new Promise((resolve, reject) => {
        try {
            const socket = new WebSocket(relayUrl);
            let resolved = false;
            
            const timeoutId = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    socket.close();
                    reject(new Error(`Connection timeout to ${relayUrl}`));
                }
            }, timeout);
            
            socket.onopen = () => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeoutId);
                    resolve(socket);
                }
            };
            
            socket.onerror = (error) => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeoutId);
                    reject(new Error(`Failed to connect to ${relayUrl}: ${error.message}`));
                }
            };
            
        } catch (error) {
            reject(new Error(`Error connecting to ${relayUrl}: ${error.message}`));
        }
    });
};

// Publish event to a specific relay
const publishEventToRelay = (relayUrl, event, timeout = 10000) => {
    return new Promise(async (resolve) => {
        let socket = null;
        let resolved = false;
        
        try {
            // Connect to relay
            socket = await connectToRelay(relayUrl, timeout);
            
            // Set up timeout for publishing
            const timeoutId = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    if (socket && socket.readyState === WebSocket.OPEN) {
                        socket.close();
                    }
                    resolve({ 
                        success: false, 
                        error: `Publish timeout to ${relayUrl}`,
                        relay: relayUrl 
                    });
                }
            }, timeout);
            
            // Handle relay response
            const handleMessage = (msg) => {
                if (resolved) return;
                
                try {
                    const data = JSON.parse(msg.data);
                    if (Array.isArray(data) && data[0] === "OK" && data[1] === event.id) {
                        resolved = true;
                        clearTimeout(timeoutId);
                        socket.removeEventListener('message', handleMessage);
                        socket.close();
                        
                        const success = data[2] === true;
                        resolve({ 
                            success, 
                            error: success ? null : (data[3] || 'Unknown error'),
                            relay: relayUrl 
                        });
                    }
                } catch (error) {
                    console.error(`Error parsing response from ${relayUrl}:`, error);
                }
            };
            
            socket.addEventListener('message', handleMessage);
            
            // Send the event
            const publishMessage = JSON.stringify(["EVENT", event]);
            socket.send(publishMessage);
            
        } catch (error) {
            if (!resolved) {
                resolved = true;
                resolve({ 
                    success: false, 
                    error: error.message,
                    relay: relayUrl 
                });
            }
        }
    });
};

/**
 * POST /api/nostr/post
 * Post to Nostr using user-provided signed event
 * 
 * Expected payload:
 * {
 *   signedEvent: { // Complete signed Nostr event
 *     id: "event_id_hex",
 *     pubkey: "pubkey_hex", 
 *     created_at: 1234567890,
 *     kind: 1,
 *     tags: [],
 *     content: "Post content with media URLs",
 *     sig: "signature_hex"
 *   },
 *   relays: ["wss://relay1.com"] // optional, will use defaults
 * }
 */
router.post('/post', validatePrivs, async (req, res) => {
    try {
        const { 
            signedEvent,
            relays = DEFAULT_RELAYS
        } = req.body;

        // Validation
        if (!signedEvent) {
            return res.status(400).json({
                error: 'Missing signedEvent',
                message: 'Signed Nostr event is required'
            });
        }

        // Use the new NostrService
        const NostrService = require('../utils/NostrService');
        const nostrService = new NostrService();
        
        const result = await nostrService.postToNostr({ signedEvent, relays });
        
        res.json(result);

    } catch (error) {
        console.error('Error posting to Nostr:', error);
        res.status(500).json({
            error: 'Failed to post to Nostr',
            message: error.message
        });
    }
});

/**
 * GET /api/nostr/relays
 * Get default relay list for Nostr posting
 */
router.get('/relays', (req, res) => {
    const defaultRelays = [
        'wss://relay.damus.io',
        'wss://nos.lol',
        'wss://relay.snort.social',
        'wss://relay.nostr.band',
        'wss://nostr.wine'
    ];

    res.json({
        success: true,
        relays: defaultRelays,
        message: 'Default Nostr relays'
    });
});

/**
 * POST /api/nostr/validate-signature
 * Validate a Nostr signature (helper endpoint)
 * 
 * TODO: Implement signature validation logic
 */
router.post('/validate-signature', async (req, res) => {
    try {
        const { content, pubkey, signature } = req.body;

        // TODO: Implement actual signature validation
        // This will validate that the signature matches the content and pubkey
        
        // Placeholder validation
        const isValid = signature && signature.length > 50; // Basic check
        
        res.json({
            success: true,
            valid: isValid,
            message: isValid ? 'Signature is valid' : 'Invalid signature'
        });

    } catch (error) {
        console.error('Error validating Nostr signature:', error);
        res.status(500).json({
            error: 'Failed to validate signature',
            message: error.message
        });
    }
});

/**
 * GET /api/nostr/user/:pubkey
 * Get user profile information from Nostr relays
 * Supports both npub and hex pubkey formats
 */
router.get('/user/:pubkey', async (req, res) => {
    try {
        const { pubkey } = req.params;
        console.log('Nostr profile lookup request for:', pubkey);

        // Initialize NostrService
        const NostrService = require('../utils/NostrService');
        const nostrService = new NostrService();

        let npubToLookup = pubkey;

        // If it's a hex pubkey, we need to convert it to npub for our lookup
        // For now, we'll just validate the input format
        if (!pubkey.startsWith('npub1')) {
            // If it's hex, we would need to convert to npub
            // For MVP, we'll require npub format
            return res.status(400).json({
                error: 'Invalid pubkey format',
                message: 'Please provide npub format (e.g., npub1...)',
                received: pubkey
            });
        }

        // Lookup profile using NostrService
        // For this specific npub, use the correct relays for nprofile generation
        let nprofileRelays = null;
        if (npubToLookup === 'npub1rtlqca8r6auyaw5n5h3l5422dm4sry5dzfee4696fqe8s6qgudks7djtfs') {
            nprofileRelays = [
                'wss://eden.nostr.land',
                'wss://filter.nostr.wine/npub1rtlqca8r6auyaw5n5h3l5422dm4sry5dzfee4696fqe8s6qgudks7djtfs?broadcast=true'
            ];
            console.log('Using special relays for HODL npub');
        }
        
        const result = await nostrService.lookupProfile(npubToLookup, undefined, nprofileRelays);

        if (result.success && result.profile) {
            res.json({
                success: true,
                profile: result.profile,
                message: result.message,
                stats: result.stats
            });
        } else {
            res.status(404).json({
                success: false,
                error: 'Profile not found',
                message: result.message,
                stats: result.stats,
                failedRelays: result.failedRelays
            });
        }

    } catch (error) {
        console.error('Error looking up Nostr user:', error);
        res.status(500).json({
            error: 'Failed to lookup user',
            message: error.message
        });
    }
});

/**
 * POST /api/nostr/lookup-profile
 * Lookup Nostr profile by npub with optional relay specification
 */
router.post('/lookup-profile', async (req, res) => {
    try {
        const { npub, searchRelays, nprofileRelays } = req.body;
        
        if (!npub) {
            return res.status(400).json({
                error: 'Missing npub',
                message: 'npub field is required'
            });
        }

        console.log('Nostr profile lookup request:', { 
            npub, 
            searchRelayCount: searchRelays?.length || 'default',
            nprofileRelayCount: nprofileRelays?.length || 'auto'
        });

        // Initialize NostrService
        const NostrService = require('../utils/NostrService');
        const nostrService = new NostrService();

        // Lookup profile with separate relay configs
        const result = await nostrService.lookupProfile(npub, searchRelays, nprofileRelays);

        res.json(result);

    } catch (error) {
        console.error('Error in profile lookup:', error);
        res.status(500).json({
            success: false,
            error: 'Profile lookup failed',
            message: error.message
        });
    }
});

module.exports = router;
