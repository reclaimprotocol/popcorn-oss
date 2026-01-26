# Pool Manager Service

The Pool Manager is responsible for managing browser sessions, allocating Agones GameServers, and providing connection details to clients.

## API Endpoints

### 1. List Servers (Admin)
Returns a minimal list of all GameServers and their status.

- **URL**: `/admin/servers`
- **Method**: `GET`
- **Response**:
  ```json
  [
    {
      "name": "browser-fleet-xyz",
      "status": "Ready"
    },
    {
      "name": "browser-fleet-abc",
      "status": "Allocated"
    }
  ]
  ```

### 2. Claim / Create Session
Allocates a new browser session or claims an existing one if a session ID is provided (and valid/reusable logic supports it).

- **URL**: `/session`
- **Method**: `POST`
- **Body** (optional):
  ```json
  {
    "sessionId": "custom-session-id"
  }
  ```
- **Response**:
  ```json
  {
    "success": true,
    "sessionId": "anon-123456",
    "url": "http://gateway.example.com/browser/anon-123456/TOKEN/",
    "cdpUrl": "http://gateway.example.com/cdp/anon-123456/TOKEN/",
    "apiUrl": "http://gateway.example.com/api/anon-123456/TOKEN/"
  }
  ```

### 3. Get Session Details
Retrieves connection information for an active session.

- **URL**: `/session/:id`
- **Method**: `GET`
- **Response**:
  ```json
  {
    "success": true,
    "sessionId": "anon-123456",
    "url": "http://gateway.example.com/browser/anon-123456/TOKEN/",
    "cdpUrl": "http://gateway.example.com/cdp/anon-123456/TOKEN/",
    "apiUrl": "http://gateway.example.com/api/anon-123456/TOKEN/"
  }
  ```

### 4. Kill Session
Terminates a session, shutting down the associated GameServer.

- **URL**: `/session/:id`
- **Method**: `DELETE`
- **Response**:
  ```json
  {
    "success": true
  }
  ```

## URL Structures

The services are exposed via the Gateway using path-based authentication tokens:

- **Browser View**: `/browser/<session_id>/<token>/`
- **CDP Endpoint**: `/cdp/<session_id>/<token>/`
- **Kernel API**: `/api/<session_id>/<token>/`
