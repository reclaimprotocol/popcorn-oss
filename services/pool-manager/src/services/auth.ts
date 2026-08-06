import jwt from 'jsonwebtoken';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const PRIVATE_KEY_PATH = resolve(process.cwd(), 'keys', 'private.pem');

let PRIVATE_KEY: Buffer | string = '';

function loadPrivateKey(): Buffer | string {
    if (PRIVATE_KEY) {
        return PRIVATE_KEY;
    }

    try {
        if (existsSync(PRIVATE_KEY_PATH)) {
            PRIVATE_KEY = readFileSync(PRIVATE_KEY_PATH, 'utf8');
            console.log("✅ Auth: Private key loaded successfully.");
        } else {
            throw new Error(`No private key found at ${PRIVATE_KEY_PATH}`);
        }
    } catch (e) {
        console.error("❌ Auth: Error reading private key:", e);
        throw e;
    }

    return PRIVATE_KEY;
}

loadPrivateKey();

export const Auth = {
    signToken(
        sessionId: string,
        scope: 'restricted' | 'automation' | 'internal' = 'restricted',
        expiresAt?: string,
        routeBound = false,
    ): string {
        const privateKey = loadPrivateKey();
        if (!privateKey) {
            throw new Error("Private key missing when trying to sign token");
        }
        if (routeBound) {
            // Route-bound URLs must remain byte-for-byte stable when access is
            // extended. The gateway authorizes these tokens against a separate
            // Redis deadline on every request, so an embedded JWT expiry would
            // both be redundant and force the URL to change.
            return jwt.sign(
                { sub: sessionId, scope, routeBound: true },
                privateKey,
                { algorithm: 'RS256', noTimestamp: true },
            );
        }
        const expiresIn = expiresAt ? Math.max(1, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000)) : '24h';
        return jwt.sign({ sub: sessionId, scope }, privateKey, { algorithm: 'RS256', expiresIn });
    }
}
