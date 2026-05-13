import { namespacedServiceUrl } from "../config";

// Read from environment variables (sourced from K8s secrets via CSI secretObjects)
const ANALYTICS_URL = process.env.CONTROL_PLANE_URL || process.env.ANALYTICS_SERVICE_URL || namespacedServiceUrl("control-plane", 3000);
const SERVICE_AUTH_TOKEN = requireAnyEnv(["CONTROL_PLANE_AUTH_TOKEN", "ANALYTICS_AUTH_TOKEN"]);
const REGION_NAME = process.env.POPCORN_REGION || process.env.REGION || process.env.CLUSTER_NAME;

function requireAnyEnv(names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`Missing required environment variable: ${names.join(" or ")}`);
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
        console.log(`✅ Validated ${clientId} via control plane`);
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
        body: JSON.stringify({ sessionId, clientId, clientName, clusterName, region: REGION_NAME }),
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
