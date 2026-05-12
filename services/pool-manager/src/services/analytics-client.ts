import { namespacedServiceUrl } from "../config";

// Read from environment variables (sourced from K8s secrets via CSI secretObjects)
const ANALYTICS_URL = process.env.ANALYTICS_SERVICE_URL || namespacedServiceUrl("analytics-service", 3000);
const SERVICE_AUTH_TOKEN = requireEnv("ANALYTICS_AUTH_TOKEN");

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

interface ValidationCache {
  expiry: number;
  clientName: string;
}

// Cache validated client credentials (5 min TTL)
const clientCache = new Map<string, ValidationCache>();

export const AnalyticsClient = {
  async validateCredentials(clientId: string, clientSecret: string): Promise<{ valid: boolean; clientName?: string }> {
    const cacheKey = `${clientId}:${clientSecret}`;
    const cached = clientCache.get(cacheKey);

    // Check cache first
    if (cached && cached.expiry > Date.now()) {
      console.log(`✅ Validated ${clientId} from cache`);
      return { valid: true, clientName: cached.clientName };
    }

    try {
      const res = await fetch(`${ANALYTICS_URL}/validate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SERVICE_AUTH_TOKEN}`,
        },
        body: JSON.stringify({ clientId, clientSecret }),
      });

      if (!res.ok) {
        console.warn(`⚠️ Analytics service returned ${res.status}`);
        return { valid: false };
      }

      const result = await res.json();

      if (result.valid) {
        // Cache for 5 minutes
        clientCache.set(cacheKey, { expiry: Date.now() + 300000, clientName: result.clientName });
        console.log(`✅ Validated ${clientId} via analytics service`);
        return { valid: true, clientName: result.clientName };
      }

      return { valid: false };
    } catch (e) {
      console.error('❌ Failed to validate credentials:', e);
      return { valid: false };
    }
  },

  async createSession(sessionId: string, clientId: string, clientName: string, clusterName: string) {
    try {
      await fetch(`${ANALYTICS_URL}/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SERVICE_AUTH_TOKEN}`,
        },
        body: JSON.stringify({ sessionId, clientId, clientName, clusterName }),
      });

      console.log(`📊 Reported session creation for ${sessionId}`);
    } catch (e) {
      console.error('❌ Failed to report session creation:', e);
    }
  },

  async endSession(sessionId: string, status: 'deleted' | 'expired') {
    try {
      await fetch(`${ANALYTICS_URL}/sessions/${sessionId}/end`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SERVICE_AUTH_TOKEN}`,
        },
        body: JSON.stringify({ status }),
      });

      console.log(`📊 Reported session ${status} for ${sessionId}`);
    } catch (e) {
      console.error('❌ Failed to report session end:', e);
    }
  }
};
