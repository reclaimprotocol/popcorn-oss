import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${label} ${file}: ${error.message}`);
  }
}

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function outputUrl(outputDir, file) {
  return encodeURI(path.relative(outputDir, file).split(path.sep).join('/'));
}

function optionalFile(pairDir, relative) {
  if (!relative) return null;
  const file = path.resolve(pairDir, relative);
  return existsSync(file) ? file : null;
}

function discoverSide(pairDir, relativeRun, side) {
  const runFile = optionalFile(pairDir, relativeRun);
  const runDir = runFile ? path.dirname(runFile) : path.join(pairDir, side);
  const touchVideo = optionalFile(runDir, 'screen-touches.mp4');
  return { runFile, touchVideo, video: touchVideo };
}

function loadEntry(spec, baseDir) {
  const relative = typeof spec === 'string' ? spec : spec.manifest;
  if (!relative) throw new Error('Every dashboard entry requires a manifest path');
  const pairFile = path.resolve(baseDir, relative);
  const pair = readJson(pairFile, 'pair manifest');
  const pairDir = path.dirname(pairFile);
  return {
    label: typeof spec === 'object' ? spec.label : null,
    tags: typeof spec === 'object' ? spec.tags ?? [] : [],
    pairFile,
    pairDir,
    pair,
    baseline: discoverSide(pairDir, pair.baseline, 'baseline'),
    candidate: discoverSide(pairDir, pair.candidate, 'candidate'),
    comparisonFile: optionalFile(pairDir, pair.comparison),
    comparison: optionalFile(pairDir, pair.comparison)
      ? readJson(path.resolve(pairDir, pair.comparison), 'comparison manifest')
      : null,
    reportFile: optionalFile(pairDir, pair.report),
  };
}

function link(outputDir, label, file, primary = false) {
  return file
    ? `<a${primary ? ' class="primary"' : ''} href="${escapeHtml(outputUrl(outputDir, file))}">${escapeHtml(label)}</a>`
    : '';
}

function videoPanel(outputDir, title, side) {
  if (!side.video) {
    return `<section class="video missing"><h3>${escapeHtml(title)}</h3><p>No recording was selected or the file is unavailable.</p>${link(outputDir, 'Run manifest', side.runFile)}</section>`;
  }
  return `<section class="video"><h3>${escapeHtml(title)} — touch evidence</h3><video controls playsinline preload="metadata" src="${escapeHtml(outputUrl(outputDir, side.video))}"></video><div class="links">${link(outputDir, 'Open touch video', side.video)}${link(outputDir, 'Run manifest', side.runFile)}</div></section>`;
}

function metricsPanel(comparison) {
  const metrics = Array.isArray(comparison?.summaryMetrics) ? comparison.summaryMetrics : [];
  if (!metrics.length) return '';
  return `<div class="metrics">${metrics.map((metric) => `<div><b>${escapeHtml(metric.value ?? '—')}</b><span>${escapeHtml(metric.label ?? 'Metric')}</span></div>`).join('')}</div>`;
}

function card(outputDir, entry) {
  const { pair, comparison } = entry;
  const verdict = pair.verdict ?? pair.status ?? 'REVIEW';
  const tags = [...new Set([...(pair.tags ?? []), ...entry.tags])];
  const search = [entry.label, pair.name, pair.testDescription, pair.reason, verdict, ...tags].filter(Boolean).join(' ').toLowerCase();
  const metrics = metricsPanel(comparison);
  return `<article class="result" data-verdict="${escapeHtml(verdict)}" data-search="${escapeHtml(search)}">
    <header><div><span class="badge badge-${escapeHtml(verdict.toLowerCase())}">${escapeHtml(verdict)}</span><h2>${escapeHtml(entry.label ?? pair.name ?? 'Unnamed result')}</h2></div><div class="links">${link(outputDir, 'Comparison', entry.reportFile, true)}${link(outputDir, 'pair.json', entry.pairFile)}${link(outputDir, 'comparison.json', entry.comparisonFile)}</div></header>
    <p class="description">${escapeHtml(pair.testDescription ?? 'No test description recorded.')}</p>
    <p><b>Result:</b> ${escapeHtml(pair.reason ?? 'No result reason recorded.')}</p>
    <div class="meta"><span>${escapeHtml(pair.startedAt ?? '')}</span><span>${escapeHtml(pair.environment?.name ?? '')}</span><span>${escapeHtml(tags.join(' · '))}</span></div>
    ${metrics}
    <div class="videos">${videoPanel(outputDir, 'Direct browser baseline', entry.baseline)}${videoPanel(outputDir, 'Popcorn LiveView', entry.candidate)}</div>
  </article>`;
}

export function buildDashboard({ configFile, manifests = [], outputFile }) {
  const configPath = configFile ? path.resolve(configFile) : null;
  const config = configPath
    ? readJson(configPath, 'dashboard config')
    : { schemaVersion: 1, title: 'Popcorn LiveView mobile evidence', description: 'Explicitly selected results.', entries: [] };
  if (config.schemaVersion !== 1) throw new Error('Dashboard config schemaVersion must be 1');
  const configDir = configPath ? path.dirname(configPath) : process.cwd();
  const specs = [...(config.entries ?? []), ...manifests];
  const entries = specs.map((spec) => loadEntry(spec, configDir));
  const absoluteOutput = path.resolve(outputFile ?? path.join(root, 'artifacts', 'index.html'));
  const outputDir = path.dirname(absoluteOutput);
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const counts = Object.groupBy(entries, (entry) => entry.pair.verdict ?? entry.pair.status ?? 'REVIEW');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(config.title)}</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#e5e7eb;background:#080b12}*{box-sizing:border-box}body{margin:0;background:linear-gradient(145deg,#080b12,#111827 55%,#172554);min-height:100vh}main{width:min(1500px,calc(100% - 28px));margin:auto;padding:30px 0 60px}.hero,.result{border:1px solid #334155;border-radius:18px;background:#0f172aed;box-shadow:0 20px 55px #0005}.hero{padding:26px}.eyebrow{color:#67e8f9;font-size:12px;font-weight:900;letter-spacing:.12em;text-transform:uppercase}h1{margin:8px 0}.hero p,.meta{color:#94a3b8}.summary{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}.summary span{padding:9px 12px;border:1px solid #334155;border-radius:10px;background:#111827}.toolbar{position:sticky;top:0;z-index:2;display:flex;gap:10px;padding:14px 0;background:#0b1020e8;backdrop-filter:blur(10px)}input,select{border:1px solid #475569;border-radius:9px;background:#111827;color:white;padding:10px 12px;font:inherit}input{flex:1}.results{display:grid;gap:18px}.result{padding:20px;min-width:0;overflow:hidden}.result header{display:flex;justify-content:space-between;gap:14px}.result h2{display:inline;margin-left:10px;font-size:21px}.badge{padding:6px 9px;border-radius:999px;font-size:12px;font-weight:900}.badge-pass{background:#166534}.badge-fail{background:#991b1b}.badge-review{background:#475569}.badge-infra_error{background:#92400e}.description{padding:10px 12px;border-left:4px solid #22d3ee;background:#0c4a6e55}.meta,.links{display:flex;flex-wrap:wrap;gap:10px}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:14px 0}.metrics div,.video{padding:12px;border:1px solid #334155;border-radius:12px;background:#020617}.metrics b{display:block;font-size:22px}.metrics span{color:#94a3b8}.videos{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:14px}.video video{display:block;width:100%;max-height:620px;background:#000;border-radius:8px}.video h3{margin-top:0}.video .links{margin-top:9px}.missing{display:flex;min-height:180px;flex-direction:column;justify-content:center;color:#94a3b8}a{color:#93c5fd;text-decoration:none}a:hover{text-decoration:underline}a.primary{padding:7px 10px;border-radius:8px;background:#2563eb;color:white;font-weight:800}.empty{padding:50px 20px;text-align:center;border:1px dashed #475569;border-radius:16px;color:#94a3b8}@media(max-width:800px){.result header{display:block}.result header .links{margin-top:12px}.metrics,.videos{grid-template-columns:1fr}.toolbar{flex-direction:column}}
</style></head><body><main>
<section class="hero"><div class="eyebrow">Explicit manifest dashboard</div><h1>${escapeHtml(config.title)}</h1><p>${escapeHtml(config.description ?? '')}</p><div class="summary"><span><b>${entries.length}</b> selected results</span><span><b>${counts.PASS?.length ?? 0}</b> pass</span><span><b>${counts.FAIL?.length ?? 0}</b> fail</span><span><b>${counts.REVIEW?.length ?? 0}</b> review</span><span><b>${counts.INFRA_ERROR?.length ?? 0}</b> infrastructure errors</span></div></section>
<div class="toolbar"><input id="search" type="search" placeholder="Filter selected results"><select id="verdict"><option value="">All verdicts</option><option>PASS</option><option>FAIL</option><option>REVIEW</option><option>INFRA_ERROR</option></select></div>
<section class="results" id="results">${entries.length ? entries.map((entry) => card(outputDir, entry)).join('') : '<p class="empty">No result manifests were selected. Add entries to a dashboard config or pass --manifest.</p>'}</section>
</main><script>
const search=document.querySelector('#search');const verdict=document.querySelector('#verdict');const cards=[...document.querySelectorAll('.result')];function apply(){const q=search.value.trim().toLowerCase();const v=verdict.value;for(const card of cards)card.hidden=Boolean((q&&!card.dataset.search.includes(q))||(v&&card.dataset.verdict!==v));}search.addEventListener('input',apply);verdict.addEventListener('change',apply);
</script></body></html>`;
  writeFileSync(absoluteOutput, html, { mode: 0o600 });
  const buildManifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    config: configPath ? path.relative(outputDir, configPath) : null,
    output: path.basename(absoluteOutput),
    entries: entries.map((entry) => path.relative(outputDir, entry.pairFile)),
  };
  writeFileSync(path.join(outputDir, 'dashboard-manifest.json'), `${JSON.stringify(buildManifest, null, 2)}\n`, { mode: 0o600 });
  console.log(absoluteOutput);
  return absoluteOutput;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs({
    args: process.argv.slice(2),
    options: {
      config: { type: 'string' },
      manifest: { type: 'string', multiple: true },
      output: { type: 'string' },
    },
  });
  try {
    buildDashboard({
      configFile: args.values.config,
      manifests: args.values.manifest ?? [],
      outputFile: args.values.output,
    });
  } catch (error) {
    console.error(error.stack || error);
    process.exit(1);
  }
}
