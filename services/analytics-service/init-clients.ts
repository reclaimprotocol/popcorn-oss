import { db } from './src/db';
import { clients } from './src/schema';
import { eq } from 'drizzle-orm';

// Initialize default clients for backwards compatibility
async function initClients() {
  console.log('🔧 Initializing default clients...');

  const defaultClients = [
    { id: 'anonymous', name: 'Anonymous (No Auth)', secretHash: '' },
    { id: 'legacy', name: 'Legacy API Token', secretHash: '' },
  ];

  for (const client of defaultClients) {
    try {
      // Check if client exists
      const existing = await db.select().from(clients).where(eq(clients.id, client.id)).limit(1);

      if (existing.length === 0) {
        // Create client
        await db.insert(clients).values({
          id: client.id,
          name: client.name,
          secretHash: client.secretHash,
          active: true,
        });
        console.log(`✅ Created default client: ${client.id}`);
      } else {
        console.log(`ℹ️  Default client already exists: ${client.id}`);
      }
    } catch (error) {
      console.error(`❌ Error creating client ${client.id}:`, error);
    }
  }

  console.log('✅ Default clients initialized');
  process.exit(0);
}

initClients().catch((error) => {
  console.error('❌ Failed to initialize clients:', error);
  process.exit(1);
});
