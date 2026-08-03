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

export interface AnalyticsSeriesPoint {
  bucketStart: string;
  created: number;
  deleted: number;
  expired: number;
  ended: number;
  avgDurationSeconds: number;
}

export interface AnalyticsRegionStat {
  region: string;
  allocated: number;
  capacity: number;
  sessions: number;
}

export interface AnalyticsClientStat {
  clientName: string;
  sessions: number;
}

export interface AnalyticsData {
  windowHours: number;
  configuredTtlSeconds: number;
  live: {
    allocated: number;
    ready: number;
    capacity: number;
    activeSessions: number;
    staleActiveSessions: number;
  };
  throughput: {
    sessionsPerMinute: number;
  };
  allocation: {
    measuredSessions: number;
    avgLatencyMs: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
  };
  window: {
    created: number;
    deleted: number;
    expired: number;
    ended: number;
    avgDurationSeconds: number;
    p50DurationSeconds: number;
    p95DurationSeconds: number;
    totalDurationSeconds: number;
  };
  byRegion: AnalyticsRegionStat[];
  topClients: AnalyticsClientStat[];
  series: AnalyticsSeriesPoint[];
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

export type AdminView = 'clients' | 'clusters' | 'analytics';

const ADMIN_VIEWS: Record<AdminView, { pagePath: string; fragmentPath: string; label: string }> = {
  clients: { pagePath: '/admin/clients', fragmentPath: '/admin/ui/clients', label: 'Clients' },
  clusters: { pagePath: '/admin/clusters', fragmentPath: '/admin/ui/clusters', label: 'Clusters' },
  analytics: { pagePath: '/admin/analytics', fragmentPath: '/admin/ui/analytics', label: 'Analytics' },
};

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

export function renderShellHtml(activeView: AdminView = 'clients') {
  return renderHtml(<AdminShell activeView={activeView} />);
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

export function renderAnalyticsViewHtml(props: Parameters<typeof AnalyticsView>[0]) {
  return renderFragment(<AnalyticsView {...props} />);
}

export function AdminShell({ activeView = 'clients' }: { activeView?: AdminView }) {
  const initialView = ADMIN_VIEWS[activeView];
  return (
    <html lang="en" data-theme="dark">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="theme-color" content="#0d141b" />
        <title>Popcorn Control Plane</title>
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" type="image/png" sizes="32x32" href="/admin/assets/favicon-32.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/admin/assets/apple-touch-icon.png" />
        <link rel="manifest" href="/admin/assets/site.webmanifest" />
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css" />
        <link rel="stylesheet" href="/admin/assets/admin.css" />
        <script src="https://unpkg.com/htmx.org@2.0.4"></script>
      </head>
      <body>
        <header class="app-header">
          <div class="brand-lockup">
            <img class="brand-mark" src="/admin/assets/favicon-32.png" alt="" width="40" height="40" />
            <div class="brand-block">
              <span class="eyebrow">Control Plane</span>
              <h1>Popcorn Operations</h1>
              <p>Route client sessions across configured regions.</p>
            </div>
          </div>
          <form method="post" action="/admin/logout">
            <button type="submit" class="secondary">Sign out</button>
          </form>
        </header>
        <nav class="view-tabs" aria-label="Admin views">
          {(Object.entries(ADMIN_VIEWS) as [AdminView, typeof initialView][]).map(([view, config]) => (
            <a
              class={`tab-button${view === activeView ? ' active' : ''}`}
              data-tab={view}
              href={config.pagePath}
              hx-get={config.fragmentPath}
              hx-push-url={config.pagePath}
              hx-target="#admin-content"
              hx-swap="innerHTML"
              aria-current={view === activeView ? 'page' : undefined}
            >
              {config.label}
            </a>
          ))}
        </nav>
        <main id="admin-content" hx-get={initialView.fragmentPath} hx-trigger="load" hx-swap="innerHTML">
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

function Metric({ label, value, tone = 'neutral', hint }: { label: string; value: string; tone?: 'neutral' | 'success' | 'warning' | 'danger'; hint?: string }) {
  return (
    <article class={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {hint ? <small class="metric-hint">{hint}</small> : null}
    </article>
  );
}

function formatDuration(seconds: number) {
  if (!seconds || seconds <= 0) return '0s';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s || !parts.length) parts.push(`${s}s`);
  return parts.join(' ');
}

function windowLabel(windowHours: number) {
  if (windowHours === 1) return 'last hour';
  if (windowHours === 24) return 'last 24 hours';
  if (windowHours % 24 === 0) return `last ${windowHours / 24} days`;
  return `last ${windowHours} hours`;
}

// Full range list for the dropdown (capped at 30 days to match the endpoint).
const ANALYTICS_RANGES = [
  { label: 'Last 1 hour', hours: 1 },
  { label: 'Last 3 hours', hours: 3 },
  { label: 'Last 6 hours', hours: 6 },
  { label: 'Last 12 hours', hours: 12 },
  { label: 'Last 24 hours', hours: 24 },
  { label: 'Last 2 days', hours: 48 },
  { label: 'Last 3 days', hours: 72 },
  { label: 'Last 7 days', hours: 168 },
  { label: 'Last 14 days', hours: 336 },
  { label: 'Last 30 days', hours: 720 },
];

// Validated dark-surface palette (admin UI renders data-theme="dark").
const VIZ = {
  deleted: '#f6685e',   // status: critical (softened for dark surface)
  expired: '#f5a623',   // status: warning
  created: '#a394f0',   // categorical violet
  allocated: '#4a90e2', // categorical blue
  ready: '#2bb673',     // categorical aqua
  free: '#33363d',      // headroom (muted)
  line: '#4a90e2',
  grid: 'rgba(255,255,255,0.06)',
  axis: '#787d85',
  ink: '#e8eaed',
};

function niceMax(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(value)));
  const norm = value / pow;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * pow;
}

// Integer y-scale with a whole-number step so axis labels never duplicate
// (e.g. a max of 2 yields ticks 0,1,2 — not 0,1,1,2,2).
function niceIntScale(rawMax: number): { max: number; ticks: number[] } {
  const target = Math.max(1, Math.ceil(rawMax));
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
  const step = steps.find((s) => target / s <= 5) ?? Math.ceil(target / 5);
  const max = Math.ceil(target / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= max; v += step) ticks.push(v);
  return { max, ticks };
}

function formatBucketLabel(iso: string, windowHours: number) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  if (windowHours <= 24) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

function xmlEscape(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Smooth monotone-cubic (Fritsch–Carlson) path — curved but never overshoots the
// data, so a spike stays a spike and the line can't dip below zero.
function smoothPath(pts: Array<{ x: number; y: number }>): string {
  const np = pts.length;
  if (np === 0) return '';
  if (np < 3) return 'M ' + pts.map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' L ');

  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < np - 1; i += 1) {
    dx[i] = pts[i + 1].x - pts[i].x;
    slope[i] = (pts[i + 1].y - pts[i].y) / dx[i];
  }

  const m: number[] = new Array(np);
  m[0] = slope[0];
  m[np - 1] = slope[np - 2];
  for (let i = 1; i < np - 1; i += 1) {
    m[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  }
  // Enforce monotonicity (prevents overshoot).
  for (let i = 0; i < np - 1; i += 1) {
    if (slope[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / slope[i];
    const b = m[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[i] = tau * a * slope[i];
      m[i + 1] = tau * b * slope[i];
    }
  }

  let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  for (let i = 0; i < np - 1; i += 1) {
    const c1x = pts[i].x + dx[i] / 3;
    const c1y = pts[i].y + (m[i] * dx[i]) / 3;
    const c2x = pts[i + 1].x - dx[i] / 3;
    const c2y = pts[i + 1].y - (m[i + 1] * dx[i]) / 3;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${pts[i + 1].x.toFixed(2)} ${pts[i + 1].y.toFixed(2)}`;
  }
  return d;
}

// Horizontal stacked capacity bar: allocated / ready / free headroom.
function capacityBarSvg(live: AnalyticsData['live']) {
  const W = 760;
  const H = 30;
  const total = Math.max(1, live.capacity);
  const segments = [
    { label: 'Allocated', value: live.allocated, color: VIZ.allocated },
    { label: 'Ready', value: live.ready, color: VIZ.ready },
    { label: 'Free', value: Math.max(0, live.capacity - live.allocated - live.ready), color: VIZ.free },
  ].filter((seg) => seg.value > 0);

  const grads = segments.map((seg, i) =>
    `<linearGradient id="anCap${i}" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0%" stop-color="${seg.color}" stop-opacity="1"/>`
    + `<stop offset="100%" stop-color="${seg.color}" stop-opacity="0.82"/></linearGradient>`,
  ).join('');

  let x = 0;
  const gap = 3;
  const rects = segments.map((seg, i) => {
    const raw = (seg.value / total) * W;
    const w = Math.max(0, raw - gap);
    const rect = `<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="${H}" rx="7" fill="url(#anCap${i})"><title>${xmlEscape(seg.label)}: ${seg.value}</title></rect>`;
    x += raw;
    return rect;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" role="img" aria-label="Fleet capacity breakdown"><defs>${grads}</defs>${rects}</svg>`;
}

// Path for a bar with only its top two corners rounded (anchored to baseline).
function topRoundedRect(x: number, y: number, w: number, h: number, r: number): string {
  const rad = Math.max(0, Math.min(r, w / 2, h));
  const right = x + w;
  const bottom = y + h;
  return `M ${x.toFixed(2)} ${bottom.toFixed(2)}`
    + ` L ${x.toFixed(2)} ${(y + rad).toFixed(2)}`
    + ` Q ${x.toFixed(2)} ${y.toFixed(2)} ${(x + rad).toFixed(2)} ${y.toFixed(2)}`
    + ` L ${(right - rad).toFixed(2)} ${y.toFixed(2)}`
    + ` Q ${right.toFixed(2)} ${y.toFixed(2)} ${right.toFixed(2)} ${(y + rad).toFixed(2)}`
    + ` L ${right.toFixed(2)} ${bottom.toFixed(2)} Z`;
}

// Stacked column chart of session outcomes (deleted + expired) per time bucket,
// with a smooth `created` (inflow) line overlaid on the same axis — created vs ended.
function outcomesChartSvg(series: AnalyticsSeriesPoint[], windowHours: number) {
  const W = 760;
  const H = 250;
  const padL = 34;
  const padR = 12;
  const padT = 16;
  const padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const baseY = padT + plotH;
  const n = series.length;
  if (!n) return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img"></svg>`;

  // One shared axis for both the ended stack and the created line.
  const { max: maxStack, ticks: yTicks } = niceIntScale(
    Math.max(1, ...series.map((p) => Math.max(p.deleted + p.expired, p.created))),
  );
  const step = plotW / n;
  const barW = Math.min(step * 0.5, 26);
  const cxOf = (i: number) => padL + (i + 0.5) * step;
  const cyOf = (v: number) => baseY - (plotH * v) / maxStack;

  const grid = yTicks.map((v) => {
    const y = cyOf(v);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="${VIZ.grid}" stroke-width="1"/>`
      + `<text x="${(padL - 8).toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="${VIZ.axis}">${v}</text>`;
  }).join('');

  const labelEvery = Math.max(1, Math.ceil(n / 6));
  const bars = series.map((p, i) => {
    const cx = cxOf(i);
    const hd = (plotH * p.deleted) / maxStack;
    const he = (plotH * p.expired) / maxStack;
    const bx = cx - barW / 2;
    const parts: string[] = [];
    const tip = `${xmlEscape(formatBucketLabel(p.bucketStart, windowHours))} · killed ${p.deleted} · expired ${p.expired} · created ${p.created}`;
    const topRounded = he <= 0 && hd > 0; // deleted is the top segment only if no expired above
    if (hd > 0) {
      parts.push(topRounded
        ? `<path d="${topRoundedRect(bx, baseY - hd, barW, hd, 3)}" fill="${VIZ.deleted}"><title>${tip}</title></path>`
        : `<rect x="${bx.toFixed(2)}" y="${(baseY - hd).toFixed(2)}" width="${barW.toFixed(2)}" height="${hd.toFixed(2)}" fill="${VIZ.deleted}"><title>${tip}</title></rect>`);
    }
    if (he > 0) {
      const eh = he - (hd > 0 ? 2 : 0); // 2px surface gap above deleted
      const ey = baseY - hd - (hd > 0 ? 2 : 0) - eh;
      parts.push(`<path d="${topRoundedRect(bx, ey, barW, eh, 3)}" fill="${VIZ.expired}"><title>${tip}</title></path>`);
    }
    const label = i % labelEvery === 0
      ? `<text x="${cx.toFixed(1)}" y="${(baseY + 16).toFixed(1)}" text-anchor="middle" font-size="10" fill="${VIZ.axis}">${xmlEscape(formatBucketLabel(p.bucketStart, windowHours))}</text>`
      : '';
    return `<g class="an-bar">${parts.join('')}</g>${label}`;
  }).join('');

  // Smooth created (inflow) line on the same axis, with a soft halo for contrast over bars.
  const pts = series.map((p, i) => ({ x: cxOf(i), y: cyOf(p.created) }));
  const path = smoothPath(pts);
  const createdHalo = `<path d="${path}" fill="none" stroke="${VIZ.created}" stroke-width="6" stroke-opacity="0.18" stroke-linejoin="round" stroke-linecap="round"/>`;
  const createdLine = `<path d="${path}" fill="none" stroke="${VIZ.created}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
  const createdDots = series.map((p, i) =>
    `<circle class="an-dot" cx="${cxOf(i).toFixed(2)}" cy="${cyOf(p.created).toFixed(2)}" r="2.5" fill="${VIZ.created}" stroke="#16181d" stroke-width="1.5"><title>${xmlEscape(formatBucketLabel(p.bucketStart, windowHours))} · created ${p.created}</title></circle>`,
  ).join('');

  const axis = `<line x1="${padL}" y1="${baseY}" x2="${padL + plotW}" y2="${baseY}" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="auto" role="img" aria-label="Sessions created vs ended per interval by outcome">`
    + `${grid}${bars}${createdHalo}${createdLine}${createdDots}${axis}</svg>`;
}

// Two-slice donut: deleted vs expired outcome split. Elegant thin ring with a
// faint track, rounded segment caps, and a large centered total.
function outcomeDonutSvg(deleted: number, expired: number) {
  const total = deleted + expired;
  const size = 190;
  const cx = size / 2;
  const cy = size / 2;
  const r = 72;
  const strokeW = 18;
  const circ = 2 * Math.PI * r;
  const track = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="${strokeW}"/>`;

  if (total <= 0) {
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Outcome split">`
      + `${track}<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="12" fill="${VIZ.axis}">no data</text></svg>`;
  }

  const segs = [
    { value: deleted, color: VIZ.deleted, label: 'killed' },
    { value: expired, color: VIZ.expired, label: 'expired' },
  ].filter((s) => s.value > 0);
  const rounded = segs.length > 1;

  let offset = 0;
  const arcs = segs.map((s) => {
    const frac = s.value / total;
    const dash = frac * circ;
    // Rounded caps extend ~strokeW/2 past each end; trim so segments read separated.
    const visible = rounded ? Math.max(1, dash - strokeW) : dash;
    const seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${strokeW}"`
      + `${rounded ? ' stroke-linecap="round"' : ''}`
      + ` stroke-dasharray="${visible.toFixed(2)} ${(circ - visible).toFixed(2)}"`
      + ` stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"><title>${s.label}: ${s.value} (${Math.round(frac * 100)}%)</title></circle>`;
    offset += dash;
    return seg;
  }).join('');

  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Outcome split killed vs expired">`
    + `${track}${arcs}`
    + `<text x="${cx}" y="${cy - 1}" text-anchor="middle" font-size="30" font-weight="650" letter-spacing="-0.02em" fill="${VIZ.ink}">${total}</text>`
    + `<text x="${cx}" y="${(cy + 17).toFixed(0)}" text-anchor="middle" font-size="10.5" letter-spacing="0.06em" fill="${VIZ.axis}">ENDED</text></svg>`;
}

// Smooth area + line chart of average session duration per time bucket.
function durationChartSvg(series: AnalyticsSeriesPoint[], windowHours: number) {
  const W = 760;
  const H = 250;
  const padL = 44;
  const padR = 12;
  const padT = 16;
  const padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const baseY = padT + plotH;
  const n = series.length;
  if (!n) return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img"></svg>`;

  const maxY = niceMax(Math.max(1, ...series.map((p) => p.avgDurationSeconds)));
  const step = plotW / n;
  const px = (i: number) => padL + (i + 0.5) * step;
  const py = (v: number) => baseY - (plotH * v) / maxY;

  const grid = [0, 1, 2, 3, 4].map((t) => {
    const v = (maxY * t) / 4;
    const y = baseY - (plotH * t) / 4;
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="${VIZ.grid}" stroke-width="1"/>`
      + `<text x="${(padL - 8).toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="${VIZ.axis}">${xmlEscape(formatDuration(v))}</text>`;
  }).join('');

  const pts = series.map((p, i) => ({ x: px(i), y: py(p.avgDurationSeconds) }));
  const linePath = smoothPath(pts);
  // Area = smooth top + down to baseline; clipped so the curve never bleeds below.
  const areaPath = `${linePath} L ${pts[n - 1].x.toFixed(2)} ${baseY} L ${pts[0].x.toFixed(2)} ${baseY} Z`;

  const labelEvery = Math.max(1, Math.ceil(n / 6));
  const marks = series.map((p, i) => {
    const label = i % labelEvery === 0
      ? `<text x="${px(i).toFixed(1)}" y="${(baseY + 16).toFixed(1)}" text-anchor="middle" font-size="10" fill="${VIZ.axis}">${xmlEscape(formatBucketLabel(p.bucketStart, windowHours))}</text>`
      : '';
    const dot = p.ended > 0
      ? `<circle class="an-dot" cx="${px(i).toFixed(2)}" cy="${py(p.avgDurationSeconds).toFixed(2)}" r="2.5" fill="${VIZ.line}" stroke="#16181d" stroke-width="1.5"><title>${xmlEscape(formatBucketLabel(p.bucketStart, windowHours))} · avg ${xmlEscape(formatDuration(p.avgDurationSeconds))} · ${p.ended} ended</title></circle>`
      : '';
    return dot + label;
  }).join('');

  const axis = `<line x1="${padL}" y1="${baseY}" x2="${padL + plotW}" y2="${baseY}" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>`;
  const defs = `<defs>`
    + `<linearGradient id="anDurGrad" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0%" stop-color="${VIZ.line}" stop-opacity="0.30"/>`
    + `<stop offset="100%" stop-color="${VIZ.line}" stop-opacity="0"/></linearGradient>`
    + `<clipPath id="anDurClip"><rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}"/></clipPath>`
    + `</defs>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="auto" role="img" aria-label="Average session duration per interval">`
    + `${defs}${grid}`
    + `<g clip-path="url(#anDurClip)"><path d="${areaPath}" fill="url(#anDurGrad)"/>`
    + `<path d="${linePath}" fill="none" stroke="${VIZ.line}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/></g>`
    + `${marks}${axis}</svg>`;
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span class="viz-legend-item">
      <span class="viz-swatch" style={`background:${color}`}></span>
      {label}
    </span>
  );
}

function AnKpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'accent' | 'danger' | 'warning' | 'success' }) {
  return (
    <div class={`an-kpi${tone ? ` ${tone}` : ''}`}>
      <span class="an-kpi-label">{label}</span>
      <strong class="an-kpi-value">{value}</strong>
      {hint ? <span class="an-kpi-hint">{hint}</span> : null}
    </div>
  );
}

// Per-region live allocation as labeled utilization bars.
function RegionBreakdown({ regions }: { regions: AnalyticsRegionStat[] }) {
  if (!regions.length) return <div class="viz-empty">No enabled regions.</div>;
  return (
    <div class="bar-list">
      {regions.map((r) => {
        const pct = percent(r.allocated, r.capacity);
        return (
          <div class="bar-row">
            <div class="bar-row-head">
              <span class="bar-row-label">{r.region}</span>
              <span class="bar-row-value">{r.allocated}/{r.capacity} · {r.sessions} sessions</span>
            </div>
            <div class="bar-track"><div class="bar-fill blue" style={`width:${pct}%`}></div></div>
          </div>
        );
      })}
    </div>
  );
}

// Top clients by sessions created in the window, as ranked bars.
function TopClients({ clients }: { clients: AnalyticsClientStat[] }) {
  if (!clients.length) return <div class="viz-empty">No sessions in this window.</div>;
  const max = Math.max(1, ...clients.map((c) => c.sessions));
  return (
    <div class="bar-list">
      {clients.map((c, i) => (
        <div class="bar-row">
          <div class="bar-row-head">
            <span class="bar-row-label"><span class="bar-rank">{i + 1}</span>{c.clientName}</span>
            <span class="bar-row-value">{c.sessions}</span>
          </div>
          <div class="bar-track"><div class="bar-fill green" style={`width:${percent(c.sessions, max)}%`}></div></div>
        </div>
      ))}
    </div>
  );
}

const ANALYTICS_STYLE = `
/* Scoped analytics design system — a clean, spacious dashboard that overrides the
   shell's admin-panel chrome. Everything is namespaced under .analytics-workspace. */
.analytics-workspace {
  --an-bg: transparent;
  --an-card: #16181d;
  --an-card-hover: #1a1d23;
  --an-border: rgba(255,255,255,0.08);
  --an-border-strong: rgba(255,255,255,0.14);
  --an-ink: #e8eaed;
  --an-muted: #9aa0a6;
  --an-faint: #6b7075;
  --an-accent: #4a90e2;
  --an-radius: 12px;
  display: block; height: 100%; min-height: 0; overflow-y: auto; overflow-x: hidden;
  padding: 0.25rem 0.5rem 1.5rem 0.25rem;
  color: var(--an-ink);
  font-feature-settings: "tnum" 0;
}
.analytics-workspace * { box-sizing: border-box; }

/* Topbar: page title + segmented window control */
.an-topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.25rem; }
.an-title h2 { margin: 0; font-size: 1.25rem; font-weight: 650; letter-spacing: -0.01em; color: var(--an-ink); }
.an-title p { margin: 0.2rem 0 0; font-size: 0.82rem; color: var(--an-muted); }
.an-controls { display: flex; align-items: center; gap: 0.5rem; }
.an-range { margin: 0; width: auto; height: auto; min-width: 9.5rem; appearance: none; -webkit-appearance: none; border: 1px solid var(--an-border); background-color: rgba(255,255,255,0.04); background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23787d85' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 0.7rem center; color: var(--an-ink); font-size: 0.82rem; font-weight: 550; padding: 0.42rem 2rem 0.42rem 0.85rem; border-radius: 8px; cursor: pointer; transition: border-color 0.12s; line-height: 1.2; }
.an-range:hover { border-color: var(--an-border-strong); }
.an-range:focus { outline: none; border-color: var(--an-accent); box-shadow: 0 0 0 3px rgba(74,144,226,0.18); }
.an-refresh { margin: 0; border: 1px solid var(--an-border); background: rgba(255,255,255,0.03); color: var(--an-muted); font-size: 0.8rem; padding: 0.42rem 0.8rem; border-radius: 8px; cursor: pointer; transition: color 0.12s, border-color 0.12s; }
.an-refresh:hover { color: var(--an-ink); border-color: var(--an-border-strong); }

/* Section labels */
.an-sublabel { font-size: 0.68rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--an-faint); margin: 1.4rem 0 0.65rem; }
.an-sublabel:first-of-type { margin-top: 0.25rem; }

/* KPI cards */
.an-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(148px, 1fr)); gap: 0.7rem; }
.an-kpi { background: var(--an-card); border: 1px solid var(--an-border); border-radius: var(--an-radius); padding: 0.85rem 0.95rem; display: flex; flex-direction: column; gap: 0.15rem; transition: border-color 0.12s, background 0.12s; }
.an-kpi:hover { border-color: var(--an-border-strong); background: var(--an-card-hover); }
.an-kpi-label { font-size: 0.7rem; font-weight: 550; letter-spacing: 0.03em; text-transform: uppercase; color: var(--an-faint); }
.an-kpi-value { font-size: 1.7rem; font-weight: 650; line-height: 1.1; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; color: var(--an-ink); }
.an-kpi-hint { font-size: 0.72rem; color: var(--an-muted); font-variant-numeric: tabular-nums; }
.an-kpi.accent .an-kpi-value { color: var(--an-accent); }
.an-kpi.danger .an-kpi-value { color: ${VIZ.deleted}; }
.an-kpi.warning .an-kpi-value { color: ${VIZ.expired}; }
.an-kpi.success .an-kpi-value { color: ${VIZ.ready}; }

/* Cards (utilization + charts) */
.an-card { background: var(--an-card); border: 1px solid var(--an-border); border-radius: var(--an-radius); padding: 1.1rem 1.15rem; }
.an-card + .an-card { margin-top: 0.7rem; }
.an-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.75rem; margin-bottom: 0.9rem; }
.an-card-head h3 { margin: 0; font-size: 0.9rem; font-weight: 600; color: var(--an-ink); }
.an-card-head .an-card-sub { font-size: 0.75rem; color: var(--an-muted); }
.an-util-value { font-size: 0.85rem; font-weight: 600; color: var(--an-ink); font-variant-numeric: tabular-nums; white-space: nowrap; }

.an-charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(440px, 1fr)); gap: 0.8rem; margin-top: 0.7rem; }
.an-charts .an-card { display: flex; flex-direction: column; }

/* Quiet secondary-stats line (durations, throughput) — text, not boxes */
.an-summary { display: flex; flex-wrap: wrap; gap: 0.35rem 1.4rem; margin-top: 0.7rem; font-size: 0.8rem; color: var(--an-muted); }
.an-summary span { white-space: nowrap; }
.an-summary b { color: var(--an-ink); font-weight: 600; font-variant-numeric: tabular-nums; margin-left: 0.3rem; }

/* Chart figure internals */
.viz-figure { display: flex; flex-direction: column; gap: 0.5rem; }
.viz-figure svg { display: block; max-width: 100%; overflow: visible; }
.an-card svg text { font-family: inherit; }
.an-card svg .an-bar { transition: opacity 0.12s; cursor: default; }
.an-card svg:hover .an-bar { opacity: 0.55; }
.an-card svg .an-bar:hover { opacity: 1; }
.an-card svg .an-dot { transition: r 0.12s; }
.an-card svg .an-dot:hover { r: 4; }
.viz-legend { display: flex; gap: 0.9rem; flex-wrap: wrap; font-size: 0.72rem; color: var(--an-muted); margin-top: 0.35rem; }
.viz-legend-item { display: inline-flex; align-items: center; gap: 0.35rem; }
.viz-swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.fleet-capacity svg { border-radius: 7px; display: block; }
.viz-empty { color: var(--an-faint); font-size: 0.8rem; padding: 1.75rem 0; text-align: center; }

/* Donut + breakdown bars */
.donut-row { display: flex; align-items: center; gap: 1.5rem; flex-wrap: wrap; justify-content: center; }
.bar-list { display: flex; flex-direction: column; gap: 0.85rem; }
.bar-row { display: flex; flex-direction: column; gap: 0.35rem; }
.bar-row-head { display: flex; justify-content: space-between; gap: 0.75rem; font-size: 0.8rem; align-items: baseline; }
.bar-row-label { color: var(--an-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: baseline; gap: 0.5rem; }
.bar-rank { display: inline-flex; align-items: center; justify-content: center; width: 1.15rem; height: 1.15rem; border-radius: 5px; background: rgba(255,255,255,0.06); color: var(--an-faint); font-size: 0.66rem; font-weight: 600; flex: 0 0 auto; align-self: center; }
.bar-row-value { color: var(--an-ink); font-weight: 600; font-variant-numeric: tabular-nums; flex: 0 0 auto; }
.bar-track { height: 8px; background: rgba(255,255,255,0.05); border-radius: 999px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 999px; min-width: 4px; transition: filter 0.12s; }
.bar-row:hover .bar-fill { filter: brightness(1.14); }
.bar-fill.blue { background: linear-gradient(90deg, #2f6fbf, #58a2f0); }
.bar-fill.green { background: linear-gradient(90deg, #17915a, #35c680); }
`;

export function AnalyticsView({ data }: { data: AnalyticsData }) {
  const { live, window, series } = data;
  const utilization = percent(live.allocated, live.capacity);
  const free = Math.max(0, live.capacity - live.allocated - live.ready);
  const hasActivity = series.some((p) => p.ended > 0 || p.created > 0);

  return (
    <div class="workspace analytics-workspace">
      {raw(`<style>${ANALYTICS_STYLE}</style>`)}

      <div class="an-topbar">
        <div class="an-title">
          <h2>Session Analytics</h2>
          <p>Live fleet allocation and session lifecycle for the {windowLabel(data.windowHours)}.</p>
        </div>
        <div class="an-controls">
          <select
            class="an-range"
            name="windowHours"
            aria-label="Time range"
            hx-get="/admin/ui/analytics"
            hx-target="#admin-content"
            hx-swap="innerHTML"
            hx-trigger="change"
          >
            {ANALYTICS_RANGES.map((r) => (
              <option value={String(r.hours)} selected={r.hours === data.windowHours}>{r.label}</option>
            ))}
          </select>
          <button
            type="button"
            class="an-refresh"
            hx-get={`/admin/ui/analytics?windowHours=${data.windowHours}`}
            hx-target="#admin-content"
            hx-swap="innerHTML"
          >
            Refresh
          </button>
        </div>
      </div>

      <div class="an-sublabel">Live fleet</div>
      <div class="an-kpis">
        <AnKpi label="Allocated" value={String(live.allocated)} hint={`of ${live.capacity} · ${utilization}%`} tone="accent" />
        <AnKpi label="Ready" value={String(live.ready)} tone={live.ready > 0 ? 'success' : undefined} />
        <AnKpi label="Active sessions" value={String(live.activeSessions)} />
        <AnKpi
          label="Stale active"
          value={String(live.staleActiveSessions)}
          tone={live.staleActiveSessions === 0 ? 'success' : 'danger'}
        />
      </div>

      <div class="an-card" style="margin-top:0.7rem">
        <div class="an-card-head">
          <h3>Fleet utilization</h3>
          <span class="an-util-value">{utilization}% · {live.allocated}/{live.capacity} allocated</span>
        </div>
        <div class="viz-figure fleet-capacity">
          {raw(capacityBarSvg(live))}
          <div class="viz-legend">
            <LegendItem color={VIZ.allocated} label={`Allocated (${live.allocated})`} />
            <LegendItem color={VIZ.ready} label={`Ready (${live.ready})`} />
            <LegendItem color={VIZ.free} label={`Free (${free})`} />
          </div>
        </div>
      </div>

      <div class="an-sublabel">Session lifecycle · {windowLabel(data.windowHours)} · TTL {formatDuration(data.configuredTtlSeconds)}</div>
      <div class="an-kpis">
        <AnKpi label="Created" value={String(window.created)} hint={`${window.ended} ended`} />
        <AnKpi label="Avg duration" value={formatDuration(window.avgDurationSeconds)} tone="accent" />
        <AnKpi label="p50 duration" value={formatDuration(window.p50DurationSeconds)} />
        <AnKpi label="p95 duration" value={formatDuration(window.p95DurationSeconds)} />
        <AnKpi label="Throughput" value={`${data.throughput.sessionsPerMinute}`} hint="sessions / min" />
        <AnKpi label="Total session time" value={formatDuration(window.totalDurationSeconds)} />
        <AnKpi
          label="Allocation p50"
          value={data.allocation.measuredSessions ? `${Math.round(data.allocation.p50LatencyMs)} ms` : '—'}
          hint={`${data.allocation.measuredSessions} measured`}
        />
        <AnKpi
          label="Allocation p95"
          value={data.allocation.measuredSessions ? `${Math.round(data.allocation.p95LatencyMs)} ms` : '—'}
          hint="request → allocated"
          tone="accent"
        />
      </div>

      <div class="an-charts">
        <div class="an-card">
          <div class="an-card-head">
            <h3>Sessions created vs ended</h3>
            <span class="an-card-sub">per interval</span>
          </div>
          {hasActivity ? raw(outcomesChartSvg(series, data.windowHours)) : <div class="viz-empty">No session activity in this window.</div>}
          <div class="viz-legend">
            <LegendItem color={VIZ.deleted} label="Killed" />
            <LegendItem color={VIZ.expired} label="Expired" />
            <LegendItem color={VIZ.created} label="Created" />
          </div>
        </div>

        <div class="an-card">
          <div class="an-card-head">
            <h3>Average session duration</h3>
            <span class="an-card-sub">per interval</span>
          </div>
          {hasActivity ? raw(durationChartSvg(series, data.windowHours)) : <div class="viz-empty">No sessions ended in this window.</div>}
          <div class="viz-legend">
            <LegendItem color={VIZ.line} label="Avg duration" />
          </div>
        </div>

        <div class="an-card">
          <div class="an-card-head">
            <h3>Outcome split</h3>
            <span class="an-card-sub">deleted vs expired</span>
          </div>
          <div class="donut-row">
            {raw(outcomeDonutSvg(window.deleted, window.expired))}
            <div class="viz-legend" style="flex-direction:column;gap:0.5rem">
              <LegendItem color={VIZ.deleted} label={`Killed · ${window.deleted}`} />
              <LegendItem color={VIZ.expired} label={`Expired · ${window.expired}`} />
            </div>
          </div>
        </div>

        <div class="an-card">
          <div class="an-card-head">
            <h3>Allocation by region</h3>
            <span class="an-card-sub">allocated / capacity</span>
          </div>
          <RegionBreakdown regions={data.byRegion} />
        </div>

        <div class="an-card">
          <div class="an-card-head">
            <h3>Top clients</h3>
            <span class="an-card-sub">by sessions created</span>
          </div>
          <TopClients clients={data.topClients} />
        </div>
      </div>
    </div>
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
                        'hx-delete': `/admin/ui/sessions/${encodeURIComponent(server.sessionId!)}?refresh=${encodeURIComponent(`/admin/ui/clusters?region=${selectedRegion}`)}`,
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
