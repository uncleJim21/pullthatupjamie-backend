const WebSocket = require('ws');
const { printLog } = require('../constants');
const { nip19 } = require('nostr-tools');

/**
 * NostrService - Reusable Nostr posting functionality
 * Extracted from nostrRoutes.js for use by both API endpoints and scheduled posts
 */
class NostrService {
    constructor() {
        // Define relay pool for Nostr - Most reliable relays only
        this.DEFAULT_RELAYS = [
            "wss://relay.primal.net",
            "wss://relay.damus.io", 
            "wss://nos.lol"
        ];

        // Bech32 encoding constants
        this.CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
        this.GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    }

    /**
     * Decode npub to hex pubkey using nostr-tools
     */
    npubToHex(npub) {
        try {
            if (!npub || !npub.startsWith('npub1')) {
                throw new Error('Invalid npub format');
            }

            // Use nostr-tools for proper npub decoding
            const decoded = nip19.decode(npub);
            
            if (decoded.type !== 'npub') {
                throw new Error(`Expected npub, got ${decoded.type}`);
            }
            
            return decoded.data;
        } catch (error) {
            throw new Error(`Failed to decode npub: ${error.message}`);
        }
    }

    /**
     * Validate npub format using nostr-tools
     */
    isValidNpub(npub) {
        try {
            if (!npub || typeof npub !== 'string') return false;
            if (!npub.startsWith('npub1')) return false;
            
            // Try to decode using nostr-tools
            const decoded = nip19.decode(npub);
            return decoded.type === 'npub' && typeof decoded.data === 'string' && decoded.data.length === 64;
        } catch (error) {
            return false;
        }
    }

    /**
     * Encode nprofile (NIP-19) from pubkey and relays using nostr-tools
     * nprofile format includes pubkey + relay information for rich profile references
     */
    encodeNprofile(hexPubkey, relays = []) {
        try {
            // Validate hex pubkey format
            if (!/^[0-9a-fA-F]{64}$/.test(hexPubkey)) {
                throw new Error('Invalid public key format: must be 64-character hex string');
            }

            // Use nostr-tools for proper nprofile encoding
            const nprofile = nip19.nprofileEncode({ 
                pubkey: hexPubkey, 
                relays: relays.slice(0, 10) // Limit to 10 relays to prevent oversized nprofiles
            });
            
            return nprofile;
        } catch (error) {
            console.error('Error encoding nprofile:', error);
            throw new Error(`Failed to encode nprofile: ${error.message}`);
        }
    }

    /**
     * Generate nprofile from npub and relays
     * Convenience method that converts npub to hex then encodes nprofile
     */
    npubToNprofile(npub, relays = []) {
        try {
            const hexPubkey = this.npubToHex(npub);
            return this.encodeNprofile(hexPubkey, relays);
        } catch (error) {
            throw new Error(`Failed to convert npub to nprofile: ${error.message}`);
        }
    }

    /**
     * Bech32 encoding utilities for nevent creation
     */
    polymod(values) {
        let chk = 1;
        for (let value of values) {
            const top = chk >> 25;
            chk = (chk & 0x1ffffff) << 5 ^ value;
            for (let i = 0; i < 5; i++) {
                if ((top >> i) & 1) {
                    chk ^= this.GENERATOR[i];
                }
            }
        }
        return chk;
    }

    hrpExpand(hrp) {
        const result = [];
        for (let i = 0; i < hrp.length; i++) {
            result.push(hrp.charCodeAt(i) >> 5);
        }
        result.push(0);
        for (let i = 0; i < hrp.length; i++) {
            result.push(hrp.charCodeAt(i) & 31);
        }
        return result;
    }

    hexToBytes(hex) {
        const result = [];
        for (let i = 0; i < hex.length; i += 2) {
            result.push(parseInt(hex.slice(i, i + 2), 16));
        }
        return result;
    }

    convertBits(data, fromBits, toBits, pad) {
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
    }

    encodeBech32(prefix, data) {
        try {
            // Convert event ID to bytes
            const eventIdBytes = this.hexToBytes(data);

            // Create TLV data
            const tlv = [0, 32, ...eventIdBytes]; // type 0, length 32, followed by event ID

            // Convert to 5-bit array
            const words = this.convertBits(tlv, 8, 5, true);

            // Calculate checksum
            const hrpExpanded = this.hrpExpand(prefix);
            const values = [...hrpExpanded, ...words];
            const polymodValue = this.polymod([...values, 0, 0, 0, 0, 0, 0]) ^ 1;
            const checksumWords = [];
            for (let i = 0; i < 6; i++) {
                checksumWords.push((polymodValue >> 5 * (5 - i)) & 31);
            }

            // Combine everything
            return prefix + '1' + 
                   words.map(i => this.CHARSET.charAt(i)).join('') + 
                   checksumWords.map(i => this.CHARSET.charAt(i)).join('');
        } catch (error) {
            console.error('Error encoding bech32:', error);
            return null;
        }
    }

    /**
     * Connect to a single relay
     */
    connectToRelay(relayUrl, timeout = 10000) {
        return new Promise((resolve, reject) => {
            try {
                console.log(`Connecting to relay: ${relayUrl}`);
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
                        console.log(`Connected to relay: ${relayUrl}`);
                        resolve(socket);
                    }
                };
                
                socket.onerror = (error) => {
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timeoutId);
                        console.error(`Failed to connect to relay ${relayUrl}:`, error.message);
                        reject(new Error(`Failed to connect to ${relayUrl}: ${error.message}`));
                    }
                };
                
                socket.onclose = (event) => {
                    if (!resolved) {
                        console.log(`Relay ${relayUrl} connection closed:`, event.code, event.reason);
                    }
                };
                
            } catch (error) {
                reject(new Error(`Error connecting to ${relayUrl}: ${error.message}`));
            }
        });
    }

    /**
     * Publish event to a specific relay
     */
    publishEventToRelay(relayUrl, event, timeout = 10000) {
        return new Promise(async (resolve) => {
            let socket = null;
            let resolved = false;
            let successReceived = false;
            let authSent = false;
            
            try {
                // Connect to relay
                socket = await this.connectToRelay(relayUrl, timeout);
                
                // Set up timeout for publishing
                const timeoutId = setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        if (socket && socket.readyState === WebSocket.OPEN) {
                            socket.close();
                        }
                        resolve({ 
                            success: successReceived, // Use successReceived flag
                            error: successReceived ? null : `Publish timeout to ${relayUrl}`,
                            relay: relayUrl 
                        });
                    }
                }, timeout);
                
                // Handle relay response
                const handleMessage = (msg) => {
                    if (resolved) return;
                    
                    try {
                        const data = JSON.parse(msg.data);
                        console.log(`Relay ${relayUrl} response:`, data);
                        
                        // Handle OK response
                        if (Array.isArray(data) && data[0] === "OK" && data[1] === event.id) {
                            successReceived = true;
                            resolved = true;
                            clearTimeout(timeoutId);
                            socket.removeEventListener('message', handleMessage);
                            socket.close();
                            
                            resolve({ 
                                success: true,
                                error: null,
                                relay: relayUrl 
                            });
                        }
                        
                        // Handle AUTH response
                        else if (Array.isArray(data) && data[0] === "AUTH" && !authSent) {
                            authSent = true;
                            console.log(`Relay ${relayUrl} requires auth, sending challenge response`);
                            
                            // Send auth challenge response
                            const authEvent = {
                                kind: 22242,
                                created_at: Math.floor(Date.now() / 1000),
                                content: "",
                                tags: [["challenge", data[1]]]
                            };
                            socket.send(JSON.stringify(["AUTH", authEvent]));
                            
                            // Resend the original event after auth
                            setTimeout(() => {
                                if (!resolved && socket.readyState === WebSocket.OPEN) {
                                    const publishMessage = JSON.stringify(["EVENT", event]);
                                    console.log(`Resending to relay ${relayUrl} after auth:`, publishMessage);
                                    socket.send(publishMessage);
                                }
                            }, 100);
                        }
                        
                        // Handle NOTICE response (usually errors)
                        else if (Array.isArray(data) && data[0] === "NOTICE") {
                            console.warn(`Relay ${relayUrl} notice:`, data[1]);
                            // Don't fail on notices, some relays send them as info
                        }
                        
                        // Handle EOSE (end of stored events)
                        else if (Array.isArray(data) && data[0] === "EOSE") {
                            // Some relays send EOSE to confirm receipt
                            console.log(`Relay ${relayUrl} sent EOSE, considering as success`);
                            successReceived = true;
                        }
                        
                    } catch (error) {
                        console.error(`Error parsing response from ${relayUrl}:`, error);
                    }
                };
                
                // Handle socket close
                socket.onclose = (event) => {
                    console.log(`Relay ${relayUrl} connection closed:`, event.code, event.reason);
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timeoutId);
                        resolve({ 
                            success: successReceived,
                            error: successReceived ? null : `Connection closed: ${event.reason || 'Unknown reason'}`,
                            relay: relayUrl 
                        });
                    }
                };
                
                socket.addEventListener('message', handleMessage);
                
                // Send the event
                const publishMessage = JSON.stringify(["EVENT", event]);
                console.log(`Sending to relay ${relayUrl}:`, publishMessage);
                socket.send(publishMessage);
                
                // Some relays don't send explicit OK messages
                // Consider it a success if we can send the message and keep the connection open
                setTimeout(() => {
                    if (!resolved && socket.readyState === WebSocket.OPEN) {
                        console.log(`Relay ${relayUrl}: No explicit OK received, assuming success`);
                        successReceived = true;
                        resolved = true;
                        clearTimeout(timeoutId);
                        socket.removeEventListener('message', handleMessage);
                        socket.close();
                        resolve({ 
                            success: true, 
                            error: null,
                            relay: relayUrl 
                        });
                    }
                }, 2000); // Wait 2 seconds for implicit success
                
            } catch (error) {
                console.error(`Error publishing to ${relayUrl}:`, error);
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
    }

    /**
     * Query a single relay for user relay list (kind 10002 event)
     */
    queryRelayListFromRelay(relayUrl, hexPubkey, timeout = 5000) {
        return new Promise((resolve) => {
            let socket = null;
            let resolved = false;
            let relayListFound = null;

            const resolveWithResult = (result) => {
                if (resolved) return;
                resolved = true;
                if (socket && socket.readyState === WebSocket.OPEN) {
                    socket.close();
                }
                resolve(result);
            };

            try {
                socket = new WebSocket(relayUrl);

                const timeoutId = setTimeout(() => {
                    resolveWithResult({ 
                        success: !!relayListFound, 
                        relayList: relayListFound,
                        error: relayListFound ? null : `Query timeout to ${relayUrl}`,
                        relay: relayUrl 
                    });
                }, timeout);

                socket.onopen = () => {
                    console.log(`Connected to ${relayUrl} for relay list query`);
                    
                    // Send subscription request for kind 10002 (relay list) events
                    const subscriptionId = 'relaylist_' + Math.random().toString(36).substr(2, 9);
                    const request = [
                        "REQ", 
                        subscriptionId,
                        {
                            "authors": [hexPubkey],
                            "kinds": [10002],
                            "limit": 1
                        }
                    ];
                    
                    socket.send(JSON.stringify(request));
                    console.log(`Sent relay list query to ${relayUrl}:`, JSON.stringify(request));
                };

                socket.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        console.log(`Relay list response from ${relayUrl}:`, data);

                        // Handle EVENT response (relay list data)
                        if (Array.isArray(data) && data[0] === "EVENT" && data[2]) {
                            const relayListEvent = data[2];
                            if (relayListEvent.kind === 10002 && relayListEvent.pubkey === hexPubkey) {
                                try {
                                    const relayTags = relayListEvent.tags.filter(tag => tag[0] === 'r');
                                    const relayUrls = relayTags.map(tag => tag[1]).filter(url => url);
                                    
                                    relayListFound = {
                                        relayUrls: relayUrls,
                                        created_at: relayListEvent.created_at,
                                        raw_tags: relayListEvent.tags
                                    };
                                    console.log(`Relay list found on ${relayUrl}:`, relayListFound);
                                } catch (parseError) {
                                    console.error(`Error parsing relay list content from ${relayUrl}:`, parseError);
                                }
                            }
                        }

                        // Handle EOSE (end of stored events)
                        else if (Array.isArray(data) && data[0] === "EOSE") {
                            console.log(`EOSE received from ${relayUrl} for relay list`);
                            clearTimeout(timeoutId);
                            resolveWithResult({
                                success: !!relayListFound,
                                relayList: relayListFound,
                                error: relayListFound ? null : 'Relay list not found',
                                relay: relayUrl
                            });
                        }
                    } catch (parseError) {
                        console.error(`Error parsing relay list response from ${relayUrl}:`, parseError);
                    }
                };

                socket.onerror = (error) => {
                    console.error(`Relay list query error on ${relayUrl}:`, error);
                    clearTimeout(timeoutId);
                    resolveWithResult({ 
                        success: false, 
                        relayList: null,
                        error: `Connection error: ${error.message}`,
                        relay: relayUrl 
                    });
                };

                socket.onclose = (event) => {
                    console.log(`Relay list query connection closed for ${relayUrl}:`, event.code, event.reason);
                    clearTimeout(timeoutId);
                    if (!resolved) {
                        resolveWithResult({
                            success: !!relayListFound,
                            relayList: relayListFound,
                            error: relayListFound ? null : `Connection closed: ${event.reason || 'Unknown reason'}`,
                            relay: relayUrl
                        });
                    }
                };

            } catch (error) {
                console.error(`Error querying relay list from ${relayUrl}:`, error);
                resolveWithResult({ 
                    success: false, 
                    relayList: null,
                    error: error.message,
                    relay: relayUrl 
                });
            }
        });
    }

    /**
     * Query a single relay for user profile (kind 0 event)
     */
    queryProfileFromRelay(relayUrl, hexPubkey, timeout = 5000) {
        return new Promise((resolve) => {
            let socket = null;
            let resolved = false;
            let profileFound = null;

            const resolveWithResult = (result) => {
                if (resolved) return;
                resolved = true;
                if (socket && socket.readyState === WebSocket.OPEN) {
                    socket.close();
                }
                resolve(result);
            };

            try {
                socket = new WebSocket(relayUrl);

                const timeoutId = setTimeout(() => {
                    resolveWithResult({ 
                        success: !!profileFound, 
                        profile: profileFound,
                        error: profileFound ? null : `Query timeout to ${relayUrl}`,
                        relay: relayUrl 
                    });
                }, timeout);

                socket.onopen = () => {
                    console.log(`Connected to ${relayUrl} for profile query`);
                    
                    // Send subscription request for kind 0 (metadata) events
                    const subscriptionId = 'profile_' + Math.random().toString(36).substr(2, 9);
                    const request = [
                        "REQ", 
                        subscriptionId,
                        {
                            "authors": [hexPubkey],
                            "kinds": [0],
                            "limit": 1
                        }
                    ];
                    
                    socket.send(JSON.stringify(request));
                    console.log(`Sent profile query to ${relayUrl}:`, JSON.stringify(request));
                };

                socket.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        console.log(`Profile response from ${relayUrl}:`, data);

                        // Handle EVENT response (profile data)
                        if (Array.isArray(data) && data[0] === "EVENT" && data[2]) {
                            const profileEvent = data[2];
                            if (profileEvent.kind === 0 && profileEvent.pubkey === hexPubkey) {
                                try {
                                    const profileContent = JSON.parse(profileEvent.content);
                                    profileFound = {
                                        npub: null, // Will be set by caller
                                        pubkey: profileEvent.pubkey,
                                        name: profileContent.name || null,
                                        displayName: profileContent.display_name || profileContent.displayName || profileContent.name || null,
                                        about: profileContent.about || null,
                                        picture: profileContent.picture || null,
                                        banner: profileContent.banner || null,
                                        website: profileContent.website || null,
                                        lud16: profileContent.lud16 || null,
                                        nip05: profileContent.nip05 || null,
                                        created_at: profileEvent.created_at,
                                        raw_content: profileEvent.content
                                    };
                                    console.log(`Profile found on ${relayUrl}:`, profileFound);
                                } catch (parseError) {
                                    console.error(`Error parsing profile content from ${relayUrl}:`, parseError);
                                }
                            }
                        }

                        // Handle EOSE (end of stored events)
                        else if (Array.isArray(data) && data[0] === "EOSE") {
                            console.log(`EOSE received from ${relayUrl}`);
                            clearTimeout(timeoutId);
                            resolveWithResult({
                                success: !!profileFound,
                                profile: profileFound,
                                error: profileFound ? null : 'Profile not found',
                                relay: relayUrl
                            });
                        }
                    } catch (parseError) {
                        console.error(`Error parsing response from ${relayUrl}:`, parseError);
                    }
                };

                socket.onerror = (error) => {
                    console.error(`Profile query error on ${relayUrl}:`, error);
                    clearTimeout(timeoutId);
                    resolveWithResult({ 
                        success: false, 
                        profile: null,
                        error: `Connection error: ${error.message}`,
                        relay: relayUrl 
                    });
                };

                socket.onclose = (event) => {
                    console.log(`Profile query connection closed for ${relayUrl}:`, event.code, event.reason);
                    clearTimeout(timeoutId);
                    if (!resolved) {
                        resolveWithResult({
                            success: !!profileFound,
                            profile: profileFound,
                            error: profileFound ? null : `Connection closed: ${event.reason || 'Unknown reason'}`,
                            relay: relayUrl
                        });
                    }
                };

            } catch (error) {
                console.error(`Error querying profile from ${relayUrl}:`, error);
                resolveWithResult({ 
                    success: false, 
                    profile: null,
                    error: error.message,
                    relay: relayUrl 
                });
            }
        });
    }

    /**
     * Lookup Nostr profile by npub
     * Queries multiple relays and returns the first successful result
     * 
     * @param {string} npub - Nostr public key in npub format
     * @param {Array} [searchRelays] - Optional relay list for searching, defaults to DEFAULT_RELAYS
     * @param {Array} [nprofileRelays] - Optional relay list for nprofile generation, defaults to successful search relays
     * @returns {Promise<Object>} Profile lookup result
     */
    async lookupProfile(npub, searchRelays = this.DEFAULT_RELAYS, nprofileRelays = null) {
        try {
            // Validate npub
            if (!this.isValidNpub(npub)) {
                throw new Error('Invalid npub format');
            }

            // Convert npub to hex
            const hexPubkey = this.npubToHex(npub);
            console.log(`Looking up profile for npub ${npub} (hex: ${hexPubkey.substring(0, 16)}...)`);

            // Query all relays in parallel
            const queryPromises = searchRelays.map(relay => 
                this.queryProfileFromRelay(relay, hexPubkey, 5000)
            );

            const results = await Promise.allSettled(queryPromises);
            
            // Process results
            const relayResults = results.map((result, index) => {
                if (result.status === 'fulfilled') {
                    return result.value;
                } else {
                    return {
                        success: false,
                        profile: null,
                        error: result.reason?.message || 'Unknown error',
                        relay: relays[index]
                    };
                }
            });

            // Find first successful result
            const successfulResult = relayResults.find(r => r.success && r.profile);
            const successCount = relayResults.filter(r => r.success).length;
            const failedRelays = relayResults.filter(r => !r.success);

            if (successfulResult) {
                // Add npub to profile data
                successfulResult.profile.npub = npub;

                // Generate nprofile for post creation
                try {
                    // Use specified nprofileRelays or fall back to successful search relays
                    let relaysForNprofile;
                    if (nprofileRelays && nprofileRelays.length > 0) {
                        relaysForNprofile = nprofileRelays.slice(0, 5); // Use specified relays
                        console.log('Using specified relays for nprofile generation');
                    } else {
                        // Use the relays that were successfully queried for nprofile generation
                        relaysForNprofile = relayResults
                            .filter(r => r.success)
                            .map(r => r.relay)
                            .slice(0, 5); // Limit to 5 relays for nprofile
                        console.log('Using successful search relays for nprofile generation');
                    }
                    
                    const nprofile = this.npubToNprofile(npub, relaysForNprofile);
                    successfulResult.profile.nprofile = nprofile;
                    
                    console.log(`Generated nprofile: ${nprofile.substring(0, 20)}...`);
                } catch (nprofileError) {
                    console.warn('Failed to generate nprofile:', nprofileError.message);
                    // Don't fail the entire lookup if nprofile generation fails
                    successfulResult.profile.nprofile = null;
                }

                console.log(`Profile found for ${npub} from ${successCount}/${searchRelays.length} relays`);
                return {
                    success: true,
                    profile: successfulResult.profile,
                    message: `Profile found from ${successfulResult.relay}`,
                    stats: {
                        total: searchRelays.length,
                        successful: successCount,
                        failed: searchRelays.length - successCount
                    },
                    failedRelays: failedRelays.map(r => ({ relay: r.relay, error: r.error }))
                };
            } else {
                console.log(`No profile found for ${npub} on any relay`);
                return {
                    success: false,
                    profile: null,
                    message: 'Profile not found on any relay',
                    stats: {
                        total: searchRelays.length,
                        successful: 0,
                        failed: searchRelays.length
                    },
                    failedRelays: relayResults.map(r => ({ relay: r.relay, error: r.error }))
                };
            }

        } catch (error) {
            console.error('Error looking up Nostr profile:', error);
            return {
                success: false,
                profile: null,
                message: error.message,
                error: error.message
            };
        }
    }

    /**
     * Post to Nostr using user-provided signed event
     * Core business logic extracted from /api/nostr/post endpoint
     * 
     * @param {Object} eventData - Nostr event data
     * @param {Object} eventData.signedEvent - Complete signed Nostr event
     * @param {Array} [eventData.relays] - Optional relay list, defaults to DEFAULT_RELAYS
     * @returns {Promise<Object>} Posting result with success status and details
     */
    async postToNostr({ signedEvent, relays = this.DEFAULT_RELAYS }) {
        try {
            // Validation
            if (!signedEvent) {
                throw new Error('Signed Nostr event is required');
            }

            // Validate signed event structure
            const requiredFields = ['id', 'pubkey', 'created_at', 'kind', 'content', 'sig'];
            const missingFields = requiredFields.filter(field => !signedEvent[field]);
            
            if (missingFields.length > 0) {
                throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
            }

            if (!Array.isArray(signedEvent.tags)) {
                throw new Error('Event tags must be an array');
            }

            console.log('Publishing Nostr event:', {
                id: signedEvent.id,
                pubkey: signedEvent.pubkey.substring(0, 16) + '...',
                contentLength: signedEvent.content.length,
                relayCount: relays.length
            });

            // DEBUG: Print the complete event JSON that will be signed/published
            printLog('=== FINAL EVENT JSON FOR PUBLISHING ===');
            printLog('Event object:', JSON.stringify(signedEvent, null, 2));
            printLog('=== END EVENT JSON ===');

            // Publish to all relays in parallel
            const publishPromises = relays.map(relay => 
                this.publishEventToRelay(relay, signedEvent, 10000)
            );

            const results = await Promise.allSettled(publishPromises);
            
            // Process results
            const relayResults = results.map((result, index) => {
                if (result.status === 'fulfilled') {
                    return result.value;
                } else {
                    return {
                        success: false,
                        error: result.reason?.message || 'Unknown error',
                        relay: relays[index]
                    };
                }
            });

            const successCount = relayResults.filter(r => r.success).length;
            const successfulRelays = relayResults.filter(r => r.success).map(r => r.relay);
            const failedRelays = relayResults.filter(r => !r.success);

            console.log(`Published to ${successCount}/${relays.length} relays`);

            // Consider it successful if at least one relay accepted it
            const overallSuccess = successCount > 0;

            // Create Primal.net URL using bech32 encoding
            let primalUrl = null;
            if (overallSuccess) {
                const bech32EventId = this.encodeBech32('nevent', signedEvent.id);
                if (bech32EventId) {
                    primalUrl = `https://primal.net/e/${bech32EventId}`;
                }
            }

            return {
                success: overallSuccess,
                message: overallSuccess 
                    ? `Nostr event published to ${successCount}/${relays.length} relays`
                    : 'Failed to publish to any relays',
                eventId: signedEvent.id,
                publishedRelays: successfulRelays,
                failedRelays: failedRelays.map(r => ({ relay: r.relay, error: r.error })),
                primalUrl,
                stats: {
                    total: relays.length,
                    successful: successCount,
                    failed: relays.length - successCount
                },
                timestamp: new Date().toISOString()
            };

        } catch (error) {
            console.error('Error posting to Nostr:', error);
            
            // Re-throw with structured error info for caller to handle
            const structuredError = new Error(error.message);
            structuredError.code = error.code;
            throw structuredError;
        }
    }
}

module.exports = NostrService;

