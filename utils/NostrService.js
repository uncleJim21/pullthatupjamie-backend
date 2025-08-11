const WebSocket = require('ws');
const { printLog } = require('../constants');

/**
 * NostrService - Reusable Nostr posting functionality
 * Extracted from nostrRoutes.js for use by both API endpoints and scheduled posts
 */
class NostrService {
    constructor() {
        // Define relay pool for Nostr (same as your React component)
        this.DEFAULT_RELAYS = [
            "wss://relay.primal.net",
            "wss://relay.damus.io", 
            "wss://nos.lol",
            "wss://relay.mostr.pub",
            "wss://nostr.land",
            "wss://purplerelay.com",
            "wss://relay.snort.social"
        ];

        // Bech32 encoding constants
        this.CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
        this.GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
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

