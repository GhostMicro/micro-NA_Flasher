/**
 * Web Security Utility for NA Core Hybrid Handshake
 * Uses Web Crypto API for ECDH (secp256r1 / P-256)
 */

export class SecurityManager {
    private keyPair: CryptoKeyPair | null = null;
    private sharedSecret: ArrayBuffer | null = null;

    /**
     * Generate Browser's ECC P-256 Key Pair
     */
    async generateKeyPair(): Promise<Uint8Array> {
        this.keyPair = await window.crypto.subtle.generateKey(
            {
                name: "ECDH",
                namedCurve: "P-256",
            },
            false, // non-extractable (the private key)
            ["deriveKey", "deriveBits"]
        );

        // Export public key as raw (65 bytes: 0x04 + X + Y)
        const rawPubKey = await window.crypto.subtle.exportKey("raw", this.keyPair.publicKey);

        // Strip the 0x04 header to maintain 64-byte compatibility with Firmware
        return new Uint8Array(rawPubKey.slice(1));
    }

    /**
     * Compute Shared Secret using Firmware's Public Key
     * @param firmwarePubKey 64 bytes (X || Y)
     */
    async computeSharedSecret(firmwarePubKey: Uint8Array): Promise<ArrayBuffer> {
        if (!this.keyPair) throw new Error("Key pair not generated");

        // Reconstruct the 65-byte uncompressed format (0x04 header)
        const formattedPubKey = new Uint8Array(65);
        formattedPubKey[0] = 0x04;
        formattedPubKey.set(firmwarePubKey, 1);

        const importedFirmwareKey = await window.crypto.subtle.importKey(
            "raw",
            formattedPubKey,
            {
                name: "ECDH",
                namedCurve: "P-256",
            },
            true,
            []
        );

        this.sharedSecret = await window.crypto.subtle.deriveBits(
            {
                name: "ECDH",
                public: importedFirmwareKey,
            },
            this.keyPair.privateKey,
            256
        );

        return this.sharedSecret;
    }

    /**
     * Convert Buffer to Base64 (Helper for Serial JSON)
     */
    bufferToBase64(buffer: Uint8Array): string {
        return btoa(String.fromCharCode(...buffer));
    }

    /**
     * Convert Base64 back to Uint8Array
     */
    base64ToBuffer(base64: string): Uint8Array {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }
}
