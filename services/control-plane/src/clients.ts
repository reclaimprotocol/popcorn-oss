import { db } from './db';
import { clients } from './schema';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import type { ClientCredentials, Client } from './types';

export const ClientService = {
  async createClient(name: string, allowedClusters: string[] | null = []): Promise<ClientCredentials> {
    // Generate client ID and secret
    const clientId = `client_${crypto.randomBytes(8).toString('hex')}`;
    const clientSecret = `secret_${crypto.randomBytes(32).toString('hex')}`;

    // Hash the secret for storage
    const secretHash = await bcrypt.hash(clientSecret, 10);

    // Verify the hash works immediately (sanity check)
    const hashWorks = await bcrypt.compare(clientSecret, secretHash);
    if (!hashWorks) {
      throw new Error('Hash verification failed during client creation');
    }

    // Insert into database with explicit active=true
    await db.insert(clients).values({
      id: clientId,
      name,
      secretHash,
      active: true, // Explicitly set active
      allowedClusters,
    });

    console.log(`✅ Created client: ${clientId} (${name})`);

    // Return plaintext secret ONCE (must be stored by client)
    return { clientId, clientSecret };
  },

  async validateCredentials(clientId: string, clientSecret: string): Promise<boolean> {
    // Input validation
    if (!clientId || !clientSecret) {
      console.warn('⚠️ Missing clientId or clientSecret');
      return false;
    }

    try {
      // Simple query - just get the client by ID
      const [client] = await db
        .select()
        .from(clients)
        .where(eq(clients.id, clientId))
        .limit(1);

      if (!client) {
        console.warn(`⚠️ Client not found: ${clientId}`);
        return false;
      }

      // Check if client is active
      if (client.active !== true) {
        console.warn(`⚠️ Client is inactive: ${clientId}`);
        return false;
      }

      // Validate the secret
      const valid = await bcrypt.compare(clientSecret, client.secretHash);

      if (valid) {
        console.log(`✅ Valid credentials for client: ${clientId}`);
      } else {
        console.warn(`⚠️ Invalid secret for client: ${clientId}`);
      }

      return valid;
    } catch (error) {
      console.error('❌ Error validating credentials:', error);
      return false;
    }
  },

  async revokeClient(clientId: string): Promise<void> {
    await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
    console.log(`🚫 Revoked client: ${clientId}`);
  },

  async updateAllowedClusters(clientId: string, allowedClusters: string[] | null): Promise<boolean> {
    const rows = await db.update(clients).set({ allowedClusters })
      .where(eq(clients.id, clientId))
      .returning({ id: clients.id });
    return rows.length > 0;
  },

  async deleteClient(clientId: string): Promise<void> {
    await db.delete(clients).where(eq(clients.id, clientId));
    console.log(`Deleted client: ${clientId}`);
  },

  async listClients(): Promise<Client[]> {
    const result = await db.select({
      id: clients.id,
      name: clients.name,
      createdAt: clients.createdAt,
      active: clients.active,
      allowedClusters: clients.allowedClusters,
    }).from(clients);

    return result.sort((a, b) => {
      if (a.active !== b.active) {
        return a.active ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  },

  async getClient(clientId: string): Promise<Client | null> {
    const [client] = await db
      .select({
        id: clients.id,
        name: clients.name,
        createdAt: clients.createdAt,
        active: clients.active,
        allowedClusters: clients.allowedClusters,
      })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);

    return client || null;
  }
};
