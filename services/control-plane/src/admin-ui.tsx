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
  };
  throughput: {
    sessionsPerMinute: number;
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

export function renderAnalyticsViewHtml(props: Parameters<typeof AnalyticsView>[0]) {
  return renderFragment(<AnalyticsView {...props} />);
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
          <button
            type="button"
            class="tab-button"
            data-tab="analytics"
            hx-get="/admin/ui/analytics"
            hx-target="#admin-content"
            hx-swap="innerHTML"
          >
            Analytics
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

const ANALYTICS_WINDOWS = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
];

// Validated dark-surface palette (admin UI renders data-theme="dark").
const VIZ = {
  deleted: '#d03b3b',   // status: critical
  expired: '#fab219',   // status: warning
  created: '#9085e9',   // categorical violet
  allocated: '#3987e5', // categorical blue
  ready: '#199e70',     // categorical aqua
  free: '#3a3a37',      // headroom (muted)
  line: '#3987e5',
  grid: '#2c2c2a',
  axis: '#898781',
  ink: '#e8e8e3',
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

  let x = 0;
  const gap = 2;
  const rects = segments.map((seg) => {
    const raw = (seg.value / total) * W;
    const w = Math.max(0, raw - gap);
    const rect = `<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="${H}" rx="6" fill="${seg.color}"><title>${xmlEscape(seg.label)}: ${seg.value}</title></rect>`;
    x += raw;
    return rect;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" role="img" aria-label="Fleet capacity breakdown">${rects}</svg>`;
}

// Stacked column chart of session outcomes (deleted + expired) per time bucket,
// with a `created` (inflow) line overlaid on the same axis — created vs ended.
function outcomesChartSvg(series: AnalyticsSeriesPoint[], windowHours: number) {
  const W = 760;
  const H = 260;
  const padL = 40;
  const padR = 14;
  const padT = 14;
  const padB = 32;
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
  const barW = Math.min(step * 0.62, 38);
  const cxOf = (i: number) => padL + (i + 0.5) * step;
  const cyOf = (v: number) => baseY - (plotH * v) / maxStack;

  const grid = yTicks.map((v) => {
    const y = baseY - (plotH * v) / maxStack;
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="${VIZ.grid}" stroke-width="1"/>`
      + `<text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="${VIZ.axis}">${v}</text>`;
  }).join('');

  const labelEvery = Math.max(1, Math.ceil(n / 6));
  const bars = series.map((p, i) => {
    const cx = padL + (i + 0.5) * step;
    const hd = (plotH * p.deleted) / maxStack;
    const he = (plotH * p.expired) / maxStack;
    const bx = cx - barW / 2;
    const parts: string[] = [];
    const tip = `${xmlEscape(formatBucketLabel(p.bucketStart, windowHours))} · deleted ${p.deleted} · expired ${p.expired}`;
    if (hd > 0) {
      parts.push(`<rect x="${bx.toFixed(2)}" y="${(baseY - hd).toFixed(2)}" width="${barW.toFixed(2)}" height="${hd.toFixed(2)}" rx="2" fill="${VIZ.deleted}"><title>${tip}</title></rect>`);
    }
    if (he > 0) {
      const ey = baseY - hd - 2 - he;
      parts.push(`<rect x="${bx.toFixed(2)}" y="${ey.toFixed(2)}" width="${barW.toFixed(2)}" height="${he.toFixed(2)}" rx="2" fill="${VIZ.expired}"><title>${tip}</title></rect>`);
    }
    const label = i % labelEvery === 0
      ? `<text x="${cx.toFixed(1)}" y="${(baseY + 16).toFixed(1)}" text-anchor="middle" font-size="10" fill="${VIZ.axis}">${xmlEscape(formatBucketLabel(p.bucketStart, windowHours))}</text>`
      : '';
    return parts.join('') + label;
  }).join('');

  // Created (inflow) line on the same axis.
  const linePts = series.map((p, i) => `${cxOf(i).toFixed(2)},${cyOf(p.created).toFixed(2)}`);
  const createdLine = `<path d="M ${linePts.join(' L ')}" fill="none" stroke="${VIZ.created}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  const createdDots = series.map((p, i) =>
    `<circle cx="${cxOf(i).toFixed(2)}" cy="${cyOf(p.created).toFixed(2)}" r="2.5" fill="${VIZ.created}"><title>${xmlEscape(formatBucketLabel(p.bucketStart, windowHours))} · created ${p.created}</title></circle>`,
  ).join('');

  const axis = `<line x1="${padL}" y1="${baseY}" x2="${padL + plotW}" y2="${baseY}" stroke="${VIZ.axis}" stroke-width="1"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="auto" role="img" aria-label="Sessions created vs ended per interval by outcome">${grid}${bars}${createdLine}${createdDots}${axis}</svg>`;
}

// Two-slice donut: deleted vs expired outcome split. Center shows total ended.
function outcomeDonutSvg(deleted: number, expired: number) {
  const total = deleted + expired;
  const size = 180;
  const cx = size / 2;
  const cy = size / 2;
  const r = 66;
  const strokeW = 26;
  const circ = 2 * Math.PI * r;

  if (total <= 0) {
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Outcome split">`
      + `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${VIZ.grid}" stroke-width="${strokeW}"/>`
      + `<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="12" fill="${VIZ.axis}">no data</text></svg>`;
  }

  const segs = [
    { value: deleted, color: VIZ.deleted, label: 'deleted' },
    { value: expired, color: VIZ.expired, label: 'expired' },
  ].filter((s) => s.value > 0);

  let offset = 0;
  const arcs = segs.map((s) => {
    const frac = s.value / total;
    const dash = frac * circ;
    // 2px surface gap between segments
    const seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${strokeW}"`
      + ` stroke-dasharray="${Math.max(0, dash - 2).toFixed(2)} ${(circ - Math.max(0, dash - 2)).toFixed(2)}"`
      + ` stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"><title>${s.label}: ${s.value} (${Math.round(frac * 100)}%)</title></circle>`;
    offset += dash;
    return seg;
  }).join('');

  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Outcome split deleted vs expired">`
    + `${arcs}`
    + `<text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="26" font-weight="600" fill="${VIZ.ink}">${total}</text>`
    + `<text x="${cx}" y="${cy + 16}" text-anchor="middle" font-size="11" fill="${VIZ.axis}">ended</text></svg>`;
}

// Area + line chart of average session duration per time bucket.
function durationChartSvg(series: AnalyticsSeriesPoint[], windowHours: number) {
  const W = 760;
  const H = 260;
  const padL = 48;
  const padR = 14;
  const padT = 14;
  const padB = 32;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const baseY = padT + plotH;
  const n = series.length;
  if (!n) return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img"></svg>`;

  const maxY = niceMax(Math.max(1, ...series.map((p) => p.avgDurationSeconds)));
  const step = plotW / n;
  const px = (i: number) => padL + (i + 0.5) * step;
  const py = (v: number) => baseY - (plotH * v) / maxY;

  const ticks = [0, 1, 2, 3, 4];
  const grid = ticks.map((t) => {
    const v = (maxY * t) / 4;
    const y = baseY - (plotH * t) / 4;
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="${VIZ.grid}" stroke-width="1"/>`
      + `<text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="${VIZ.axis}">${xmlEscape(formatDuration(v))}</text>`;
  }).join('');

  const linePts = series.map((p, i) => `${px(i).toFixed(2)},${py(p.avgDurationSeconds).toFixed(2)}`);
  const linePath = `M ${linePts.join(' L ')}`;
  const areaPath = `M ${px(0).toFixed(2)},${baseY} L ${linePts.join(' L ')} L ${px(n - 1).toFixed(2)},${baseY} Z`;

  const labelEvery = Math.max(1, Math.ceil(n / 6));
  const dots = series.map((p, i) => {
    const label = i % labelEvery === 0
      ? `<text x="${px(i).toFixed(1)}" y="${(baseY + 16).toFixed(1)}" text-anchor="middle" font-size="10" fill="${VIZ.axis}">${xmlEscape(formatBucketLabel(p.bucketStart, windowHours))}</text>`
      : '';
    const dot = p.ended > 0
      ? `<circle cx="${px(i).toFixed(2)}" cy="${py(p.avgDurationSeconds).toFixed(2)}" r="3" fill="${VIZ.line}"><title>${xmlEscape(formatBucketLabel(p.bucketStart, windowHours))} · avg ${xmlEscape(formatDuration(p.avgDurationSeconds))} · ${p.ended} ended</title></circle>`
      : '';
    return dot + label;
  }).join('');

  const axis = `<line x1="${padL}" y1="${baseY}" x2="${padL + plotW}" y2="${baseY}" stroke="${VIZ.axis}" stroke-width="1"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="auto" role="img" aria-label="Average session duration per interval">`
    + `${grid}<path d="${areaPath}" fill="${VIZ.line}" fill-opacity="0.14"/>`
    + `<path d="${linePath}" fill="none" stroke="${VIZ.line}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
    + `${dots}${axis}</svg>`;
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span class="viz-legend-item">
      <span class="viz-swatch" style={`background:${color}`}></span>
      {label}
    </span>
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
            <div class="bar-track"><div class="bar-fill" style={`width:${pct}%;background:${VIZ.allocated}`}></div></div>
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
      {clients.map((c) => (
        <div class="bar-row">
          <div class="bar-row-head">
            <span class="bar-row-label">{c.clientName}</span>
            <span class="bar-row-value">{c.sessions}</span>
          </div>
          <div class="bar-track"><div class="bar-fill" style={`width:${percent(c.sessions, max)}%;background:${VIZ.ready}`}></div></div>
        </div>
      ))}
    </div>
  );
}

const ANALYTICS_STYLE = `
/* Analytics is a tall vertical report — scroll the whole workspace as one block
   instead of the shell's viewport-locked, internally-scrolling panel layout. */
.analytics-workspace { display: block; height: 100%; min-height: 0; overflow-y: auto; overflow-x: hidden; padding-right: 4px; }
.analytics-workspace > section { display: block; overflow: visible; min-height: 0; margin-bottom: 1rem; }
.analytics-workspace > section:last-child { margin-bottom: 0; }
.analytics-workspace .panel-body { display: block; flex: none; overflow: visible; min-height: 0; }
.analytics-workspace .panel-body.stack { display: flex; flex-direction: column; gap: 0.75rem; }
.analytics-workspace .section-heading { flex: 0 0 auto; }
/* Compact metric grid — pack tiles into as many columns as fit instead of the
   shell's default single-column stack. */
.analytics-workspace .stat-strip { grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 0.55rem; }
.analytics-workspace .metric { padding: 0.55rem 0.7rem; }
.analytics-workspace .metric span { font-size: 0.72rem; }
.analytics-workspace .metric strong { font-size: 1.15rem; margin-top: 0.1rem; }
.analytics-workspace .command-panel .section-heading { padding-bottom: 0.5rem; }
.analytics-workspace .panel-body.stack { gap: 0.6rem; }
.analytics-controls { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.window-picker { display: inline-flex; gap: 0.25rem; }
.window-picker button { margin: 0; padding: 0.3rem 0.7rem; }
.window-picker button.active { background: var(--pico-primary, #3987e5); color: #fff; border-color: var(--pico-primary, #3987e5); }
.viz-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1rem; }
.viz-figure { display: flex; flex-direction: column; gap: 0.5rem; }
.viz-figure h3 { margin: 0; font-size: 0.95rem; }
.viz-figure .viz-sub { margin: 0; font-size: 0.75rem; color: #898781; }
.viz-figure svg { display: block; max-width: 100%; overflow: visible; }
.viz-legend { display: flex; gap: 1rem; flex-wrap: wrap; font-size: 0.75rem; color: #c3c2b7; }
.viz-legend-item { display: inline-flex; align-items: center; gap: 0.35rem; }
.viz-swatch { width: 11px; height: 11px; border-radius: 3px; display: inline-block; }
.fleet-capacity { margin-top: 0.25rem; }
.fleet-capacity svg { border-radius: 6px; }
.viz-figure .gauge-heading { display: flex; justify-content: space-between; align-items: baseline; gap: 0.75rem; font-size: 0.85rem; color: #c3c2b7; }
.viz-figure .gauge-heading strong { color: #e8e8e3; font-variant-numeric: tabular-nums; }
.viz-empty { color: #898781; font-size: 0.8rem; padding: 1.5rem 0; text-align: center; }
.metric-hint { display: block; margin-top: 0.2rem; font-size: 0.68rem; color: #898781; }
.donut-figure { align-items: center; }
.donut-row { display: flex; align-items: center; gap: 1.25rem; flex-wrap: wrap; }
.bar-list { display: flex; flex-direction: column; gap: 0.6rem; }
.bar-row { display: flex; flex-direction: column; gap: 0.25rem; }
.bar-row-head { display: flex; justify-content: space-between; gap: 0.75rem; font-size: 0.78rem; }
.bar-row-label { color: #e8e8e3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-row-value { color: #898781; font-variant-numeric: tabular-nums; flex: 0 0 auto; }
.bar-track { height: 8px; background: #2c2c2a; border-radius: 999px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 999px; min-width: 2px; }
`;

export function AnalyticsView({ data }: { data: AnalyticsData }) {
  const { live, window, series } = data;
  const utilization = percent(live.allocated, live.capacity);
  const free = Math.max(0, live.capacity - live.allocated - live.ready);
  const hasActivity = series.some((p) => p.ended > 0 || p.created > 0);

  return (
    <div class="workspace analytics-workspace">
      {raw(`<style>${ANALYTICS_STYLE}</style>`)}
      <section class="panel command-panel">
        <div class="section-heading">
          <div>
            <span class="eyebrow">Operations Analytics</span>
            <h2>Session Stats</h2>
            <p>Live fleet allocation from Agones plus session lifecycle stats for the selected window.</p>
          </div>
          <div class="analytics-controls">
            <div class="window-picker" role="group" aria-label="Time window">
              {ANALYTICS_WINDOWS.map((win) => (
                <button
                  type="button"
                  class={`secondary${win.hours === data.windowHours ? ' active' : ''}`}
                  hx-get={`/admin/ui/analytics?windowHours=${win.hours}`}
                  hx-target="#admin-content"
                  hx-swap="innerHTML"
                >
                  {win.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              class="secondary"
              hx-get={`/admin/ui/analytics?windowHours=${data.windowHours}`}
              hx-target="#admin-content"
              hx-swap="innerHTML"
            >
              Refresh
            </button>
          </div>
        </div>
        <div class="panel-body stack">
          <div class="stat-strip">
            <Metric label="Allocated instances" value={String(live.allocated)} tone={live.allocated > 0 ? 'warning' : 'neutral'} />
            <Metric label="Capacity" value={String(live.capacity)} tone="neutral" />
            <Metric label="Ready" value={String(live.ready)} tone={live.ready > 0 ? 'success' : 'warning'} />
            <Metric label="Active sessions" value={String(live.activeSessions)} tone="neutral" />
          </div>
          <div class="viz-figure fleet-capacity">
            <div class="gauge-heading">
              <span>Fleet utilization</span>
              <strong>{utilization}% · {live.allocated}/{live.capacity} allocated</strong>
            </div>
            {raw(capacityBarSvg(live))}
            <div class="viz-legend">
              <LegendItem color={VIZ.allocated} label={`Allocated (${live.allocated})`} />
              <LegendItem color={VIZ.ready} label={`Ready (${live.ready})`} />
              <LegendItem color={VIZ.free} label={`Free (${free})`} />
            </div>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="section-heading">
          <div>
            <span class="eyebrow">Session Lifecycle</span>
            <h2>Window ({windowLabel(data.windowHours)})</h2>
            <p>Sessions that ended within the window, keyed off their end time.</p>
          </div>
        </div>
        <div class="panel-body stack">
          <div class="stat-strip">
            <Metric label="Created" value={String(window.created)} tone="neutral" />
            <Metric label="Killed (deleted)" value={String(window.deleted)} tone={window.deleted > 0 ? 'danger' : 'neutral'} />
            <Metric label="Expired (TTL)" value={String(window.expired)} tone={window.expired > 0 ? 'warning' : 'neutral'} hint={`TTL ${formatDuration(data.configuredTtlSeconds)}`} />
            <Metric label="Total ended" value={String(window.ended)} tone="neutral" />
            <Metric label="Throughput" value={`${data.throughput.sessionsPerMinute}/min`} tone="neutral" />
            <Metric label="Avg duration" value={formatDuration(window.avgDurationSeconds)} tone="neutral" />
            <Metric label="p50 duration" value={formatDuration(window.p50DurationSeconds)} tone="neutral" />
            <Metric label="p95 duration" value={formatDuration(window.p95DurationSeconds)} tone="neutral" />
            <Metric label="Total session time" value={formatDuration(window.totalDurationSeconds)} tone="neutral" />
          </div>

          <div class="viz-grid">
            <figure class="viz-figure">
              <h3>Sessions created vs ended</h3>
              <p class="viz-sub">Inflow (line) vs sessions ended by outcome (bars), per interval</p>
              {hasActivity ? raw(outcomesChartSvg(series, data.windowHours)) : <div class="viz-empty">No session activity in this window.</div>}
              <figcaption class="viz-legend">
                <LegendItem color={VIZ.deleted} label="Deleted (killed)" />
                <LegendItem color={VIZ.expired} label="Expired (TTL)" />
                <LegendItem color={VIZ.created} label="Created" />
              </figcaption>
            </figure>

            <figure class="viz-figure">
              <h3>Average session duration</h3>
              <p class="viz-sub">Mean lifetime of sessions ending in each interval</p>
              {hasActivity ? raw(durationChartSvg(series, data.windowHours)) : <div class="viz-empty">No sessions ended in this window.</div>}
              <figcaption class="viz-legend">
                <LegendItem color={VIZ.line} label="Avg duration" />
              </figcaption>
            </figure>

            <figure class="viz-figure donut-figure">
              <h3>Outcome split</h3>
              <p class="viz-sub">Deleted vs expired of sessions ended</p>
              <div class="donut-row">
                {raw(outcomeDonutSvg(window.deleted, window.expired))}
                <div class="viz-legend" style="flex-direction:column;gap:0.4rem">
                  <LegendItem color={VIZ.deleted} label={`Deleted ${window.deleted}`} />
                  <LegendItem color={VIZ.expired} label={`Expired ${window.expired}`} />
                </div>
              </div>
            </figure>

            <figure class="viz-figure">
              <h3>Live allocation by region</h3>
              <p class="viz-sub">Allocated / capacity and sessions created this window</p>
              <RegionBreakdown regions={data.byRegion} />
            </figure>

            <figure class="viz-figure">
              <h3>Top clients</h3>
              <p class="viz-sub">By sessions created in the {windowLabel(data.windowHours)}</p>
              <TopClients clients={data.topClients} />
            </figure>
          </div>
        </div>
      </section>
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
