import { db } from './db';
import { sessions, sessionEvents } from './schema';
import { eq } from 'drizzle-orm';

export const SessionService = {
  // Create a new session
  async createSession(sessionId: string, clientId: string, clientName: string, clusterName: string): Promise<void> {
    try {
      await db.insert(sessions).values({
        sessionId,
        clientId,
        clientName,
        clusterName,
        createdAt: new Date(),
        status: 'active',
      });

      console.log(`📊 Created session: ${sessionId} (client: ${clientName}, cluster: ${clusterName})`);
    } catch (error) {
      console.error('❌ Error creating session:', error);
      throw error;
    }
  },

  // End a session (delete or expire)
  async endSession(sessionId: string, status: 'deleted' | 'expired'): Promise<void> {
    try {
      const endedAt = new Date();

      await db.update(sessions)
        .set({ endedAt, status })
        .where(eq(sessions.sessionId, sessionId));

      console.log(`📊 Ended session: ${sessionId} (status: ${status})`);
    } catch (error) {
      console.error('❌ Error ending session:', error);
      throw error;
    }
  },

  // Get session info
  async getSession(sessionId: string) {
    return await db.select().from(sessions).where(eq(sessions.sessionId, sessionId)).limit(1);
  }
};
