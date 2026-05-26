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
    signToken(sessionId: string, scope: 'restricted' | 'internal' = 'restricted', expiresAt?: string): string {
        const privateKey = loadPrivateKey();
        if (!privateKey) {
            throw new Error("Private key missing when trying to sign token");
        }
        const expiresIn = expiresAt ? Math.max(1, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000)) : '24h';
        return jwt.sign({ sub: sessionId, scope }, privateKey, { algorithm: 'RS256', expiresIn });
    }
}
