import { Hono } from 'hono';
import { ClientService } from './src/clients';
import { SessionService } from './src/sessions';

const app = new Hono();
const PORT = 3000;

// Read from environment variables (sourced from K8s secrets via CSI secretObjects)
const SERVICE_AUTH_TOKEN = requireEnv('SERVICE_AUTH_TOKEN');
const ADMIN_TOKEN = requireEnv('ADMIN_TOKEN');

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

console.log(`🚀 Starting Analytics Service on port ${PORT}...`);

// Health check
app.get('/health', (c) => c.text('OK'));

// Session creation (from pool-managers)
app.post('/sessions', async (c) => {
  const authToken = c.req.header('Authorization')?.replace('Bearer ', '');

  if (authToken !== SERVICE_AUTH_TOKEN) {
    console.warn('⚠️ Unauthorized session creation attempt');
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const { sessionId, clientId, clientName, clusterName } = await c.req.json();

    if (!sessionId || !clientId || !clientName || !clusterName) {
      return c.json({ error: 'Missing required fields' }, 400);
    }

    await SessionService.createSession(sessionId, clientId, clientName, clusterName);
    return c.json({ success: true });
  } catch (error) {
    console.error('❌ Error creating session:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Session end (from pool-managers or TTL controller)
app.post('/sessions/:id/end', async (c) => {
  const authToken = c.req.header('Authorization')?.replace('Bearer ', '');

  if (authToken !== SERVICE_AUTH_TOKEN) {
    console.warn('⚠️ Unauthorized session end attempt');
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const sessionId = c.req.param('id');
    const { status } = await c.req.json();

    if (!status || (status !== 'deleted' && status !== 'expired')) {
      return c.json({ error: 'Invalid status. Must be "deleted" or "expired"' }, 400);
    }

    await SessionService.endSession(sessionId, status);
    return c.json({ success: true });
  } catch (error) {
    console.error('❌ Error ending session:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Validate client credentials (from pool-managers)
app.post('/validate', async (c) => {
  const authToken = c.req.header('Authorization')?.replace('Bearer ', '');

  if (authToken !== SERVICE_AUTH_TOKEN) {
    console.warn('⚠️ Unauthorized validation attempt');
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const { clientId, clientSecret } = await c.req.json();

    if (!clientId || !clientSecret) {
      return c.json({ error: 'Missing credentials' }, 400);
    }

    const valid = await ClientService.validateCredentials(clientId, clientSecret);

    if (valid) {
      const client = await ClientService.getClient(clientId);
      return c.json({ valid: true, clientId, clientName: client?.name });
    }

    return c.json({ valid: false });
  } catch (error) {
    console.error('❌ Error validating credentials:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Admin: List all clients
app.get('/admin/clients', async (c) => {
  const adminToken = c.req.header('Authorization')?.replace('Bearer ', '');

  if (adminToken !== ADMIN_TOKEN) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const clientsList = await ClientService.listClients();
    return c.json({ clients: clientsList });
  } catch (error) {
    console.error('❌ Error listing clients:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Admin: Create new client
app.post('/admin/clients', async (c) => {
  const adminToken = c.req.header('Authorization')?.replace('Bearer ', '');

  if (adminToken !== ADMIN_TOKEN) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const { name } = await c.req.json();

    if (!name) {
      return c.json({ error: 'Missing client name' }, 400);
    }

    const credentials = await ClientService.createClient(name);

    // Return client ID + secret (show only once!)
    return c.json({
      success: true,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      message: 'IMPORTANT: Save the client secret securely. It will not be shown again.'
    });
  } catch (error) {
    console.error('❌ Error creating client:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Admin: Revoke client
app.delete('/admin/clients/:id', async (c) => {
  const adminToken = c.req.header('Authorization')?.replace('Bearer ', '');

  if (adminToken !== ADMIN_TOKEN) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const clientId = c.req.param('id');
    await ClientService.revokeClient(clientId);
    return c.json({ success: true, message: `Client ${clientId} has been revoked` });
  } catch (error) {
    console.error('❌ Error revoking client:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default {
  port: PORT,
  fetch: app.fetch,
};
