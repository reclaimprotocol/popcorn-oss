# Analytics Service

Central usage tracking service for Popcorn browser sessions across all clusters.

## Features

- **Client Credentials Authentication**: OAuth2-style client ID + secret
- **Event Tracking**: Records session creation and deletion events
- **PostgreSQL + TimescaleDB**: Time-series optimized storage
- **Drizzle ORM**: Type-safe database queries
- **Admin API**: Manage clients and API keys

## Setup

### 1. Install Dependencies

```bash
bun install
```

### 2. Configure Environment

```bash
export POSTGRES_HOST=<rds-endpoint>
export POSTGRES_USER=analytics_admin
export POSTGRES_PASSWORD=<password>
export POSTGRES_DB=analytics
export SERVICE_AUTH_TOKEN=<token-for-pool-managers>
export ADMIN_TOKEN=<token-for-admin-operations>
```

### 3. Run Migrations

```bash
bun run db:generate
bun run db:migrate
```

GCP deploys run Drizzle migrations from a dedicated Kubernetes `Job` before the analytics deployment rolls forward.

### 4. Enable TimescaleDB Hypertable

Connect to PostgreSQL and run:

```sql
SELECT create_hypertable('session_events', 'timestamp');
SELECT add_retention_policy('session_events', INTERVAL '90 days');
```

### 5. Start Service

```bash
bun run dev  # Development with hot reload
bun run start  # Production
```

## API Endpoints

### POST /validate
Validate client credentials (called by pool-managers)

**Headers:**
```
Authorization: Bearer <SERVICE_AUTH_TOKEN>
```

**Request:**
```json
{
  "clientId": "client_abc123",
  "clientSecret": "secret_xyz..."
}
```

**Response:**
```json
{
  "valid": true,
  "clientId": "client_abc123",
  "clientName": "Client Name"
}
```

### POST /events
Record session event (called by pool-managers with service token)

**Headers:**
```
Authorization: Bearer <SERVICE_AUTH_TOKEN>
```

**Request:**
```json
{
  "sessionId": "f4e8a2b1",
  "clientId": "client_abc123",
  "clusterName": "aws-us-east-2",
  "eventType": "created",
  "timestamp": "2025-01-15T10:30:00Z"
}
```

### POST /admin/clients
Create new client (requires admin token)

**Headers:**
```
Authorization: Bearer <ADMIN_TOKEN>
```

**Request:**
```json
{
  "name": "Client Name"
}
```

**Response:**
```json
{
  "success": true,
  "clientId": "client_abc123",
  "clientSecret": "secret_xyz...",
  "message": "IMPORTANT: Save the client secret securely. It will not be shown again."
}
```

### GET /admin/clients
List all clients (requires admin token)

### DELETE /admin/clients/:id
Revoke client (requires admin token)

## Database Schema

### clients
- `id` (text, PK): Client ID (e.g., "client_abc123")
- `name` (text): Client name
- `secret_hash` (text): bcrypt hashed secret
- `created_at` (timestamp): Creation timestamp
- `active` (boolean): Active status

### session_events (TimescaleDB hypertable)
- `id` (uuid, PK): Event ID
- `session_id` (text): Session identifier
- `client_id` (text, FK): Client who created the session
- `cluster_name` (text): Cluster where session ran
- `event_type` (text): 'created' or 'deleted'
- `timestamp` (timestamp): Event timestamp (hypertable partition key)
- `duration_seconds` (int): Session duration (for 'deleted' events)
- `metadata` (jsonb): Additional metadata

## Performance

- **Client validation**: O(1) indexed lookup + 1 bcrypt compare (~5-10ms)
- **Event ingestion**: Single insert with indexes (~2-5ms)
- **Pool-manager caching**: 5-minute TTL on validated credentials

## Usage Example

1. **Create a client:**
```bash
curl -X POST https://analytics.popcorn.internal/admin/clients \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Production Client"}'
```

2. **Use credentials in pool-manager requests:**
```bash
curl -X POST https://gateway.popcorn.com/session \
  -H "Authorization: Bearer client_abc123:secret_xyz..."
```

3. **View analytics in Metabase dashboard**
