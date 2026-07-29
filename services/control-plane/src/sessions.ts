import { db } from './db';
import { sessions, sessionEvents } from './schema';
import { and, count, desc, eq, isNull } from 'drizzle-orm';

export const SessionService = {
  // Create a new session
  async createSession(sessionId: string, clientId: string, clientName: string, clusterName: string, region?: string, metadata?: Record<string, unknown>): Promise<void> {
    try {
      const createdAt = new Date();
      await db.transaction(async (tx) => {
        await tx.insert(sessions).values({
          sessionId,
          clientId,
          clientName,
          clusterName,
          region,
          createdAt,
          status: 'active',
          metadata,
        });
        await tx.insert(sessionEvents).values({
          sessionId,
          eventType: 'created',
          timestamp: createdAt,
          metadata,
        });
      });

      console.log(`📊 Created session: ${sessionId} (client: ${clientName}, cluster: ${clusterName})`);
    } catch (error) {
      console.error('❌ Error creating session:', error);
      throw error;
    }
  },

  // End a session (delete or expire)
  async endSession(sessionId: string, status: 'deleted' | 'expired'): Promise<boolean> {
    try {
      const endedAt = new Date();

      const changed = await db.transaction(async (tx) => {
        const updated = await tx.update(sessions)
          .set({ endedAt, status })
          .where(and(eq(sessions.sessionId, sessionId), isNull(sessions.endedAt)))
          .returning({ sessionId: sessions.sessionId });
        if (!updated.length) {
          return false;
        }
        await tx.insert(sessionEvents).values({
          sessionId,
          eventType: status,
          timestamp: endedAt,
        });
        return true;
      });

      console.log(`📊 Ended session: ${sessionId} (status: ${status}, changed: ${changed})`);
      return changed;
    } catch (error) {
      console.error('❌ Error ending session:', error);
      throw error;
    }
  },

  // Get session info
  async getSession(sessionId: string) {
    return await db.select().from(sessions).where(eq(sessions.sessionId, sessionId)).limit(1);
  },

  async listSessions(limit = 100, clientId?: string, offset = 0) {
    if (clientId) {
      return await db.select()
        .from(sessions)
        .where(eq(sessions.clientId, clientId))
        .orderBy(desc(sessions.createdAt))
        .limit(limit)
        .offset(offset);
    }

    return await db.select()
      .from(sessions)
      .orderBy(desc(sessions.createdAt))
      .limit(limit)
      .offset(offset);
  },

  async countSessionsForClient(clientId: string): Promise<number> {
    const [row] = await db.select({ value: count() })
      .from(sessions)
      .where(eq(sessions.clientId, clientId));
    return row?.value || 0;
  },

  async updateSessionExpiresAt(sessionId: string, expiresAt: string): Promise<void> {
    const [session] = await this.getSession(sessionId);
    const metadata = {
      ...(session?.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata) ? session.metadata as Record<string, unknown> : {}),
      expiresAt,
    };

    await this.updateSessionMetadata(sessionId, metadata);
  },

  async updateSessionMetadata(sessionId: string, metadata: Record<string, unknown> | null): Promise<void> {
    await db.update(sessions)
      .set({ metadata })
      .where(eq(sessions.sessionId, sessionId));
  }
};
