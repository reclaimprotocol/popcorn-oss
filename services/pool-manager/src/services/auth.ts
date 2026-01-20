import jwt from 'jsonwebtoken';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const PRIVATE_KEY_PATH = resolve(process.cwd(), 'keys', 'private.pem');

let PRIVATE_KEY: Buffer | string = '';

try {
    if (existsSync(PRIVATE_KEY_PATH)) {
        PRIVATE_KEY = readFileSync(PRIVATE_KEY_PATH, 'utf8');
        console.log("✅ Auth: Private key loaded successfully.");
    } else {
        console.warn(`⚠️ Auth: No private key found at ${PRIVATE_KEY_PATH}. Token generation will fail.`);
    }
} catch (e) {
    console.error("❌ Auth: Error reading private key:", e);
}

export const Auth = {
    signToken(sessionId: string): string {
        if (!PRIVATE_KEY) {
            console.error("❌ Auth: Private Key missing when trying to sign token.");
            return ""; // Or throw, but let's avoid crashing logic if possible, or maybe failing open/closed?
        }
        return jwt.sign({ sub: sessionId }, PRIVATE_KEY, { algorithm: 'RS256', expiresIn: '24h' });
    }
}
