import type { Client } from './types';
import type { RegionConfig } from './config';
import { raw } from 'hono/html';

export interface SessionRow {
  sessionId: string;
  clientId: string;
  clientName: string;
  clusterName: string;
  region: string | null;
  createdAt: Date;
  endedAt: Date | null;
  status: string;
}

export interface SessionPagination {
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
  previousOffset: number | null;
}

export interface RegionServer {
  name?: string;
  status?: string;
  sessionId?: string;
  address?: string;
  ports?: { name?: string; port?: number }[];
}

export interface AdminRegion {
  name: string;
  clusterName: string;
  enabled: boolean;
  publicGatewayUrl: string;
  healthy: boolean;
  servers: RegionServer[];
  error: string | null;
}

export interface ClientSecretNotice {
  clientId: string;
  clientSecret: string;
}

export interface ActionNotice {
  tone: 'success' | 'error';
  title: string;
  message: string;
  href?: string;
}

function formatDate(value: Date | string | null | undefined) {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function statusClass(status: string | null | undefined) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'ready' || normalized === 'active') return 'success';
  if (normalized === 'allocated' || normalized === 'scheduled') return 'warning';
  if (normalized.includes('shut') || normalized === 'deleted' || normalized === 'expired') return 'danger';
  return 'neutral';
}

function firstEnabledRegion(regions: AdminRegion[]) {
  return regions.find((region) => region.enabled)?.name || '';
}

function regionServers(regions: AdminRegion[], selectedRegion = 'all') {
  return regions.flatMap((region) => (region.servers || []).map((server) => ({
    ...server,
    region: region.name,
    clusterName: region.clusterName,
  }))).filter((server) => selectedRegion === 'all' || server.region === selectedRegion);
}

function regionStats(region: AdminRegion) {
  const servers = region.servers || [];
  return {
    ready: servers.filter((server) => server.status === 'Ready').length,
    allocated: servers.filter((server) => server.status === 'Allocated').length,
    total: servers.length,
  };
}

function pageNumber(pagination: SessionPagination) {
  return Math.floor(pagination.offset / pagination.limit) + 1;
}

function clientCounts(clients: Client[]) {
  return {
    total: clients.length,
    active: clients.filter((client) => client.active).length,
    revoked: clients.filter((client) => !client.active).length,
  };
}

function clusterTotals(regions: AdminRegion[]) {
  const enabledRegions = regions.filter((region) => region.enabled);
  const healthyRegions = enabledRegions.filter((region) => region.healthy);
  const servers = regionServers(regions);
  return {
    enabled: enabledRegions.length,
    healthy: healthyRegions.length,
    ready: servers.filter((server) => server.status === 'Ready').length,
    allocated: servers.filter((server) => server.status === 'Allocated').length,
    total: servers.length,
  };
}

function percent(part: number, total: number) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((part / total) * 100)));
}

function clientQuery(clientId: string | null | undefined) {
  return clientId ? `?clientId=${encodeURIComponent(clientId)}` : '';
}

export async function renderHtml(node: any) {
  return `<!DOCTYPE html>${await node.toString()}`;
}

export async function renderFragment(node: any) {
  return await node.toString();
}

export function renderShellHtml() {
  return renderHtml(<AdminShell />);
}

export function renderClientsViewHtml(props: Parameters<typeof ClientsView>[0]) {
  return renderFragment(<ClientsView {...props} />);
}

export function renderClientSessionsPanelHtml(props: Parameters<typeof ClientSessionsPanel>[0]) {
  return renderFragment(<ClientSessionsPanel {...props} />);
}

export function renderClustersViewHtml(props: Parameters<typeof ClustersView>[0]) {
  return renderFragment(<ClustersView {...props} />);
}

export function AdminShell() {
  return (
    <html lang="en" data-theme="dark">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Popcorn Control Plane</title>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css" />
        <link rel="stylesheet" href="/admin/assets/admin.css" />
        <script src="https://unpkg.com/htmx.org@2.0.4"></script>
      </head>
      <body>
        <header class="app-header">
          <div class="brand-block">
            <span class="eyebrow">Control Plane</span>
            <h1>Popcorn Operations</h1>
            <p>Route client sessions across configured regions.</p>
          </div>
          <form method="post" action="/admin/logout">
            <button type="submit" class="secondary">Sign out</button>
          </form>
        </header>
        <nav class="view-tabs" aria-label="Admin views">
          <button
            type="button"
            class="tab-button active"
            data-tab="clients"
            hx-get="/admin/ui/clients"
            hx-target="#admin-content"
            hx-swap="innerHTML"
          >
            Clients
          </button>
          <button
            type="button"
            class="tab-button"
            data-tab="clusters"
            hx-get="/admin/ui/clusters"
            hx-target="#admin-content"
            hx-swap="innerHTML"
          >
            Clusters
          </button>
        </nav>
        <main id="admin-content" hx-get="/admin/ui/clients" hx-trigger="load" hx-swap="innerHTML">
          <section aria-busy="true">Loading Control Plane...</section>
        </main>
        <script>
          {raw(`
          document.body.addEventListener('htmx:beforeRequest', (event) => {
            const tab = event.target.closest('[data-tab]');
            if (!tab) return;
            document.querySelectorAll('[data-tab]').forEach((node) => {
              node.classList.toggle('active', node === tab);
            });
          });
          const preservedScroll = new Map();
          document.body.addEventListener('htmx:beforeSwap', () => {
            document.querySelectorAll('[data-preserve-scroll]').forEach((node) => {
              preservedScroll.set(node.getAttribute('data-preserve-scroll'), node.scrollTop);
            });
          });
          document.body.addEventListener('htmx:afterSettle', () => {
            document.querySelectorAll('[data-preserve-scroll]').forEach((node) => {
              const key = node.getAttribute('data-preserve-scroll');
              if (preservedScroll.has(key)) {
                node.scrollTop = preservedScroll.get(key);
              }
            });
          });
          document.body.addEventListener('htmx:afterRequest', (event) => {
            if (event.detail.failed) return;
            const source = event.detail.elt;
            if (source && source.matches('[data-clear-on-success]')) {
              source.reset();
            }
          });
          `)}
        </script>
      </body>
    </html>
  );
}

export function ClientsView(props: {
  clients: Client[];
  selectedClientId?: string | null;
  sessions: SessionRow[];
  pagination: SessionPagination;
  secretNotice?: ClientSecretNotice | null;
  notice?: ActionNotice | null;
}) {
  const selectedClient = props.clients.find((client) => client.id === props.selectedClientId) || props.clients[0] || null;
  const counts = clientCounts(props.clients);
  const selectedActiveSessions = props.sessions.filter((session) => session.status === 'active').length;
  return (
    <div class="workspace clients-workspace">
      <section class="panel command-panel">
        <div class="section-heading">
          <div>
            <span class="eyebrow">Client Management</span>
            <h2>Directory</h2>
            <p>Create clients, rotate access by revoking old credentials, and inspect session ownership.</p>
          </div>
          <button
            type="button"
            class="secondary"
            hx-get={`/admin/ui/clients${clientQuery(selectedClient?.id)}`}
            hx-target="#admin-content"
            hx-swap="innerHTML"
          >
            Refresh
          </button>
        </div>
        <div class="panel-body stack">
          <div class="stat-strip three">
            <Metric label="Total clients" value={String(counts.total)} />
            <Metric label="Active" value={String(counts.active)} tone="success" />
            <Metric label="Revoked" value={String(counts.revoked)} tone="danger" />
          </div>
          <CreateClientForm />
          {props.secretNotice ? <SecretNotice notice={props.secretNotice} /> : null}
          {props.notice ? <Notice notice={props.notice} /> : null}
          <ClientList clients={props.clients} selectedClientId={selectedClient?.id} />
        </div>
      </section>
      <div class="client-detail-stack">
        <SelectedClientCard client={selectedClient} activeSessions={selectedActiveSessions} />
        <ClientSessionsPanel client={selectedClient} sessions={props.sessions} pagination={props.pagination} />
      </div>
    </div>
  );
}

function CreateClientForm() {
  return (
    <form
      class="create-client-form"
      hx-post="/admin/ui/clients"
      hx-target="#admin-content"
      hx-swap="innerHTML"
      data-clear-on-success="true"
    >
      <label>
        New client name
        <input name="name" autocomplete="off" required placeholder="Production app, staging worker..." />
      </label>
      <button type="submit">Create client</button>
    </form>
  );
}

function SelectedClientCard({ client, activeSessions }: { client: Client | null; activeSessions: number }) {
  if (!client) {
    return (
      <section class="panel selected-entity">
        <div class="empty">Select a client to inspect credentials and sessions.</div>
      </section>
    );
  }

  return (
    <section class="panel selected-entity">
      <div class="entity-main">
        <div>
          <span class="eyebrow">Selected Client</span>
          <h2>{client.name}</h2>
          <code>{client.id}</code>
        </div>
        <span class={`status-pill ${client.active ? 'success' : 'danger'}`}>{client.active ? 'active' : 'revoked'}</span>
      </div>
      <dl class="entity-meta">
        <div>
          <dt>Created</dt>
          <dd>{formatDate(client.createdAt)}</dd>
        </div>
        <div>
          <dt>Active sessions on this page</dt>
          <dd>{activeSessions}</dd>
        </div>
      </dl>
    </section>
  );
}

function SecretNotice({ notice }: { notice: ClientSecretNotice }) {
  return (
    <article class="notice success">
      <strong>Client created</strong>
      <p>Copy this secret now. It will not be shown again.</p>
      <dl class="secret-grid">
        <dt>Client ID</dt>
        <dd><code>{notice.clientId}</code></dd>
        <dt>Client Secret</dt>
        <dd><code>{notice.clientSecret}</code></dd>
      </dl>
    </article>
  );
}

function Notice({ notice }: { notice: ActionNotice }) {
  return (
    <article class={`notice ${notice.tone}`}>
      <strong>{notice.title}</strong>
      <p>{notice.message}</p>
      {notice.href ? <a href={notice.href} target="_blank" rel="noreferrer">Open session</a> : null}
    </article>
  );
}

function ClientList({ clients, selectedClientId }: { clients: Client[]; selectedClientId?: string | null }) {
  if (!clients.length) {
    return <div class="empty">No clients yet.</div>;
  }
  const activeClients = clients.filter((client) => client.active);
  const revokedClients = clients.filter((client) => !client.active);
  return (
    <div class="client-list" data-preserve-scroll="client-directory">
      <ClientListGroup title="Active clients" clients={activeClients} selectedClientId={selectedClientId} />
      {revokedClients.length ? <ClientListGroup title="Revoked clients" clients={revokedClients} selectedClientId={selectedClientId} /> : null}
    </div>
  );
}

function ClientListGroup({ title, clients, selectedClientId }: { title: string; clients: Client[]; selectedClientId?: string | null }) {
  if (!clients.length) {
    return null;
  }
  return (
    <div class="client-list-group">
      <div class="list-label">{title}</div>
      {clients.map((client) => (
        <button
          type="button"
          class={`client-row ${client.id === selectedClientId ? 'selected' : ''}`}
          hx-get={`/admin/ui/clients?clientId=${encodeURIComponent(client.id)}`}
          hx-target="#admin-content"
          hx-swap="innerHTML"
        >
          <span>
            <strong>{client.name}</strong>
            <small><code>{client.id}</code></small>
          </span>
          <span class={`status-pill ${client.active ? 'success' : 'danger'}`}>{client.active ? 'active' : 'revoked'}</span>
        </button>
      ))}
    </div>
  );
}

export function ClientSessionsPanel({ client, sessions, pagination }: {
  client: Client | null;
  sessions: SessionRow[];
  pagination: SessionPagination;
}) {
  return (
    <section class="panel" id="client-sessions-panel">
      <div class="section-heading">
        <div>
          <span class="eyebrow">Session Ownership</span>
          <h2>Sessions</h2>
          <p>{client ? `Recent sessions created by ${client.name}.` : 'Select a client to inspect sessions.'}</p>
        </div>
        {client ? (
          <div class="heading-actions">
            <button
              type="button"
              class="contrast"
              disabled={!client.active}
              hx-delete={`/admin/ui/clients/${encodeURIComponent(client.id)}`}
              hx-target="#admin-content"
              hx-swap="innerHTML"
              hx-confirm={`Revoke client ${client.name}?`}
            >
              Revoke client
            </button>
            <button
              type="button"
              class="secondary destructive"
              disabled={client.id === 'admin'}
              hx-delete={`/admin/ui/clients/${encodeURIComponent(client.id)}/delete`}
              hx-target="#admin-content"
              hx-swap="innerHTML"
              hx-confirm={`Permanently delete client ${client.name}? This only succeeds when there is no session history.`}
            >
              Delete client
            </button>
          </div>
        ) : null}
      </div>
      <div class="table-scroll">
        <table class="ops-table sessions-table">
          <thead>
            <tr>
              <th>Session</th>
              <th>Placement</th>
              <th>Lifecycle</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {!client ? (
              <tr><td colSpan={4}><div class="empty">Select a client to view sessions.</div></td></tr>
            ) : sessions.length ? sessions.map((session) => (
              <SessionRowItem session={session} refreshPath={`/admin/ui/clients?clientId=${encodeURIComponent(client.id)}`} />
            )) : (
              <tr><td colSpan={4}><div class="empty">No sessions on this page.</div></td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination client={client} pagination={pagination} />
    </section>
  );
}

function SessionRowItem({ session, refreshPath }: { session: SessionRow; refreshPath: string }) {
  const active = session.status === 'active';
  return (
    <tr>
      <td>
        <code>{session.sessionId}</code>
        <small>Created {formatDate(session.createdAt)}</small>
      </td>
      <td>
        <strong>{session.region || '-'}</strong>
        <small>{session.clusterName}</small>
      </td>
      <td><span class={`status-pill ${statusClass(session.status)}`}>{session.status}</span></td>
      <td>
        <div class="row-actions">
          <a
            role="button"
            class={`secondary ${active ? '' : 'disabled'}`}
            href={active ? `/admin/ui/session/${encodeURIComponent(session.sessionId)}/open` : '#'}
            target="_blank"
            rel="noreferrer"
          >
            Open
          </a>
          <button
            type="button"
            class="contrast"
            disabled={!active}
            {...(active ? {
              'hx-delete': `/admin/ui/sessions/${encodeURIComponent(session.sessionId)}?refresh=${encodeURIComponent(refreshPath)}`,
              'hx-target': '#admin-content',
              'hx-swap': 'innerHTML',
              'hx-confirm': `Delete session ${session.sessionId}?`,
            } : {})}
          >
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}

function Pagination({ client, pagination }: { client: Client | null; pagination: SessionPagination }) {
  const base = client ? `/admin/ui/client-sessions?clientId=${encodeURIComponent(client.id)}&limit=${pagination.limit}` : '';
  return (
    <footer class="pager">
      <button
        type="button"
        class="secondary"
        disabled={!client || pagination.previousOffset === null}
        hx-get={client && pagination.previousOffset !== null ? `${base}&offset=${pagination.previousOffset}` : ''}
        hx-target="#client-sessions-panel"
        hx-swap="outerHTML"
      >
        Previous
      </button>
      <span>Page {client ? pageNumber(pagination) : 1}</span>
      <button
        type="button"
        class="secondary"
        disabled={!client || !pagination.hasMore}
        hx-get={client && pagination.nextOffset !== null ? `${base}&offset=${pagination.nextOffset}` : ''}
        hx-target="#client-sessions-panel"
        hx-swap="outerHTML"
      >
        Next
      </button>
    </footer>
  );
}

export function ClustersView({ regions, selectedRegion = 'all', notice }: {
  regions: AdminRegion[];
  selectedRegion?: string;
  notice?: ActionNotice | null;
}) {
  const servers = regionServers(regions, selectedRegion);
  const totals = clusterTotals(regions);
  const enabledRegions = regions.filter((region) => region.enabled);
  const createRegion = selectedRegion === 'all' ? firstEnabledRegion(regions) : selectedRegion;
  const selectedRegionDetails = selectedRegion === 'all'
    ? null
    : regions.find((region) => region.name === selectedRegion) || null;
  return (
    <div class="workspace clusters-workspace">
      <section class="panel command-panel cluster-directory-panel">
        <div class="section-heading">
          <div>
            <span class="eyebrow">Cluster Management</span>
            <h2>Directory</h2>
            <p>Choose a region to inspect capacity, create pods, and operate current sessions.</p>
          </div>
          <button
            type="button"
            class="secondary"
            hx-get={`/admin/ui/clusters?region=${encodeURIComponent(selectedRegion)}`}
            hx-target="#admin-content"
            hx-swap="innerHTML"
          >
            Refresh
          </button>
        </div>
        <div class="panel-body stack">
          <div class="stat-strip three">
            <Metric label="Healthy" value={`${totals.healthy}/${totals.enabled}`} tone={totals.healthy === totals.enabled ? 'success' : 'warning'} />
            <Metric label="Ready" value={String(totals.ready)} tone={totals.ready > 0 ? 'success' : 'warning'} />
            <Metric label="Allocated" value={String(totals.allocated)} tone={totals.allocated > 0 ? 'warning' : 'neutral'} />
          </div>
          <RegionDirectory regions={regions} selectedRegion={selectedRegion} totals={totals} />
        </div>
      </section>

      <div class="cluster-detail-stack">
        <SelectedRegionCard region={selectedRegionDetails} selectedRegion={selectedRegion} totals={totals} />

        <section class="panel allocation-panel">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Allocate Session</span>
              <h2>Create Pod</h2>
              <p>Creates a routed admin session in the selected region.</p>
            </div>
            <form
              class="cluster-create"
              hx-post="/admin/ui/sessions"
              hx-target="#admin-content"
              hx-swap="innerHTML"
              data-clear-on-success="true"
            >
              <label>
                Session name
                <input name="sessionId" placeholder="optional" autocomplete="off" />
              </label>
              <label>
                Region
                <select name="region" required>
                  {enabledRegions.map((region) => (
                    <option value={region.name} selected={region.name === createRegion}>{region.name}</option>
                  ))}
                </select>
              </label>
              <button type="submit" disabled={!enabledRegions.length}>Create pod</button>
            </form>
          </div>
          {notice ? <div class="panel-body"><Notice notice={notice} /></div> : null}
        </section>

        <section class="panel pods-panel">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Live Inventory</span>
              <h2>Current Pods</h2>
              <p>{selectedRegion === 'all' ? 'All regions' : `${selectedRegion} pods`}</p>
            </div>
          </div>
          <div class="panel-body stack">
            <PodsTable servers={servers} selectedRegion={selectedRegion} />
          </div>
        </section>
      </div>
    </div>
  );
}

function Metric({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'neutral' | 'success' | 'warning' | 'danger' }) {
  return (
    <article class={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function SelectedRegionCard({ region, selectedRegion, totals }: {
  region: AdminRegion | null;
  selectedRegion: string;
  totals: ReturnType<typeof clusterTotals>;
}) {
  if (!region) {
    return (
      <section class="panel selected-entity">
        <div class="entity-main">
          <div>
            <span class="eyebrow">Selected Scope</span>
            <h2>All regions</h2>
            <code>{totals.enabled} configured</code>
          </div>
          <span class={`status-pill ${totals.healthy === totals.enabled ? 'success' : 'warning'}`}>{totals.healthy}/{totals.enabled} healthy</span>
        </div>
        <dl class="entity-meta">
          <div>
            <dt>Ready pods</dt>
            <dd>{totals.ready}</dd>
          </div>
          <div>
            <dt>Allocated pods</dt>
            <dd>{totals.allocated}</dd>
          </div>
        </dl>
      </section>
    );
  }

  const stats = regionStats(region);
  return (
    <section class="panel selected-entity">
      <div class="entity-main">
        <div>
          <span class="eyebrow">Selected Region</span>
          <h2>{selectedRegion}</h2>
          <code>{region.clusterName}</code>
        </div>
        <span class={`status-pill ${region.healthy ? 'success' : 'danger'}`}>
          {region.healthy ? 'healthy' : region.error || 'unavailable'}
        </span>
      </div>
      <dl class="entity-meta">
        <div>
          <dt>Ready pods</dt>
          <dd>{stats.ready}</dd>
        </div>
        <div>
          <dt>Allocated pods</dt>
          <dd>{stats.allocated}</dd>
        </div>
        <div>
          <dt>Total pods</dt>
          <dd>{stats.total}</dd>
        </div>
        <div>
          <dt>Gateway</dt>
          <dd><code>{region.publicGatewayUrl}</code></dd>
        </div>
      </dl>
    </section>
  );
}

function RegionDirectory({ regions, selectedRegion, totals }: {
  regions: AdminRegion[];
  selectedRegion: string;
  totals: ReturnType<typeof clusterTotals>;
}) {
  if (!regions.length) {
    return <div class="empty">No regions configured.</div>;
  }
  const enabledRegions = regions.filter((region) => region.enabled);
  const disabledRegions = regions.filter((region) => !region.enabled);
  return (
    <div class="region-list" data-preserve-scroll="region-directory">
      <RegionScopeRow selected={selectedRegion === 'all'} totals={totals} />
      <RegionListGroup title="Enabled regions" regions={enabledRegions} selectedRegion={selectedRegion} />
      {disabledRegions.length ? <RegionListGroup title="Disabled regions" regions={disabledRegions} selectedRegion={selectedRegion} /> : null}
    </div>
  );
}

function RegionScopeRow({ selected, totals }: { selected: boolean; totals: ReturnType<typeof clusterTotals> }) {
  return (
    <button
      type="button"
      class={`region-row ${selected ? 'selected' : ''}`}
      hx-get="/admin/ui/clusters?region=all"
      hx-target="#admin-content"
      hx-swap="innerHTML"
    >
      <span>
        <strong>All regions</strong>
        <small>{totals.total} pods across {totals.enabled} enabled regions</small>
      </span>
      <span class={`status-pill ${totals.healthy === totals.enabled ? 'success' : 'warning'}`}>{totals.healthy}/{totals.enabled}</span>
    </button>
  );
}

function RegionListGroup({ title, regions, selectedRegion }: {
  title: string;
  regions: AdminRegion[];
  selectedRegion: string;
}) {
  if (!regions.length) {
    return null;
  }
  return (
    <div class="region-list-group">
      <div class="list-label">{title}</div>
      {regions.map((region) => (
        <RegionRow region={region} selected={selectedRegion === region.name} />
      ))}
    </div>
  );
}

function RegionRow({ region, selected }: { region: AdminRegion; selected: boolean }) {
  const stats = regionStats(region);
  const allocation = percent(stats.allocated, stats.total);
  return (
    <button
      type="button"
      class={`region-row ${selected ? 'selected' : ''}`}
      hx-get={`/admin/ui/clusters?region=${encodeURIComponent(region.name)}`}
      hx-target="#admin-content"
      hx-swap="innerHTML"
    >
      <span>
        <span class="region-row-title">
          <strong>{region.name}</strong>
          <small>{region.clusterName}</small>
        </span>
        <small>{stats.ready} ready, {stats.allocated} allocated, {stats.total} total</small>
        <span class="capacity-bar" aria-label={`Allocation ${allocation}%`}>
          <span style={`width: ${allocation}%`}></span>
        </span>
      </span>
      <span class={`status-pill ${!region.enabled ? 'neutral' : region.healthy ? 'success' : 'danger'}`}>
        {!region.enabled ? 'disabled' : region.healthy ? 'healthy' : region.error || 'unavailable'}
      </span>
    </button>
  );
}

function PodsTable({ servers, selectedRegion }: { servers: ReturnType<typeof regionServers>; selectedRegion: string }) {
  return (
    <div class="table-scroll">
      <table class="ops-table pods-table">
        <thead>
          <tr>
            <th>Pod</th>
            <th>Region</th>
            <th>Status</th>
            <th>Session</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {servers.length ? servers.map((server) => {
            const active = Boolean(server.sessionId);
            return (
              <tr>
                <td>
                  <code>{server.name || '-'}</code>
                  <small>{server.clusterName}</small>
                </td>
                <td>{server.region}</td>
                <td><span class={`status-pill ${statusClass(server.status)}`}>{server.status || '-'}</span></td>
                <td>{server.sessionId ? <code>{server.sessionId}</code> : <span class="muted">-</span>}</td>
                <td>
                  <div class="row-actions">
                    <a
                      role="button"
                      class={`secondary ${active ? '' : 'disabled'}`}
                      href={active ? `/admin/ui/session/${encodeURIComponent(server.sessionId!)}/open` : '#'}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open
                    </a>
                    <button
                      type="button"
                      class="contrast"
                      disabled={!active}
                      {...(active ? {
                        'hx-delete': `/admin/ui/sessions/${encodeURIComponent(server.sessionId!)}?region=${encodeURIComponent(server.region)}&refresh=${encodeURIComponent(`/admin/ui/clusters?region=${selectedRegion}`)}`,
                        'hx-target': '#admin-content',
                        'hx-swap': 'innerHTML',
                        'hx-confirm': `Delete session ${server.sessionId}?`,
                      } : {})}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            );
          }) : (
            <tr><td colSpan={5}><div class="empty">No pods in this view.</div></td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function toAdminRegion(region: RegionConfig, responseOk: boolean, body: any): AdminRegion {
  const servers = Array.isArray(body) ? body : [];
  return {
    name: region.name,
    clusterName: region.clusterName,
    enabled: region.enabled,
    publicGatewayUrl: region.publicGatewayUrl,
    healthy: responseOk,
    servers,
    error: responseOk ? null : body?.error || 'region unavailable',
  };
}
