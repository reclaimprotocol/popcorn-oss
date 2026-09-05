import { createRequire } from 'module';
const require = createRequire(import.meta.url);
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
  return {
    runFile,
    run: runFile ? readJson(runFile, `${side} run manifest`) : null,
    touchVideo,
    video: touchVideo,
  };
}

function normalizePlatform(value) {
  const platform = String(value ?? '').trim().toLowerCase();
  if (platform.includes('android')) return 'Android';
  if (platform === 'ios' || platform.includes('iphone') || platform.includes('ipad')) return 'iOS';
  return null;
}

function platformDetails(entry) {
  const runs = [entry.baseline.run, entry.candidate.run].filter(Boolean);
  const platform = [
    entry.pair.platformName,
    entry.pair.platform,
    entry.pair.device?.platformName,
    entry.pair.browser?.platformName,
    entry.pair.environment?.platformName,
    ...runs.flatMap((run) => [run.device?.platformName, run.browser?.platformName, run.platformName]),
    entry.pair.device?.name,
    ...runs.map((run) => run.device?.name),
    entry.pair.environment?.name,
  ].map(normalizePlatform).find(Boolean) ?? 'Unknown';
  const browser = entry.pair.browser?.name ?? runs.map((run) => run.browser?.name).find(Boolean)
    ?? (platform === 'Android' ? 'Chrome' : platform === 'iOS' ? 'Safari' : 'Unknown browser');
  const device = entry.pair.device?.name ?? runs.map((run) => run.device?.name).find(Boolean);
  const version = entry.pair.device?.platformVersion ?? runs.map((run) => run.device?.platformVersion).find(Boolean);
  return { platform, browser, device, version };
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

function videoPanel(outputDir, title, side, view) {
  if (!side.video) {
    return `<section class="video missing" data-view="${escapeHtml(view)}"><h3>${escapeHtml(title)}</h3><p>No recording was selected or the file is unavailable.</p>${link(outputDir, 'Run manifest', side.runFile)}</section>`;
  }
  const videoArtifact = side.run?.artifacts?.find((artifact) => artifact.file === path.basename(side.video));
  const version = String(videoArtifact?.sha256 ?? '').slice(0, 16);
  const source = `${outputUrl(outputDir, side.video)}${version ? `?v=${version}` : ''}`;
  return `<section class="video" data-view="${escapeHtml(view)}"><h3>${escapeHtml(title)} — touch evidence</h3><video controls playsinline preload="metadata" src="${escapeHtml(source)}"></video><div class="links"><a href="${escapeHtml(source)}">Open touch video</a>${link(outputDir, 'Run manifest', side.runFile)}</div></section>`;
}

function metricsPanel(comparison) {
  const metrics = Array.isArray(comparison?.summaryMetrics) ? comparison.summaryMetrics : [];
  if (!metrics.length) return '';
  return `<div class="metrics">${metrics.map((metric) => `<div><b>${escapeHtml(metric.value ?? '—')}</b><span>${escapeHtml(metric.label ?? 'Metric')}</span></div>`).join('')}</div>`;
}

function card(outputDir, entry) {
  const { pair, comparison } = entry;
  const verdict = pair.verdict ?? pair.status ?? 'REVIEW';
  const platform = platformDetails(entry);
  const tags = [...new Set([...(pair.tags ?? []), ...entry.tags])];
  const search = [entry.label, pair.name, pair.testDescription, pair.reason, verdict, platform.platform, platform.browser, platform.device, ...tags].filter(Boolean).join(' ').toLowerCase();
  const metrics = metricsPanel(comparison);
  const deviceLabel = [platform.browser, platform.device, platform.version ? `${platform.platform} ${platform.version}` : null].filter(Boolean).join(' · ');
  return `<article class="result" data-verdict="${escapeHtml(verdict)}" data-platform="${escapeHtml(platform.platform)}" data-search="${escapeHtml(search)}">
    <header><div class="result-title"><span class="badge badge-${escapeHtml(verdict.toLowerCase())}">${escapeHtml(verdict)}</span><span class="platform platform-${escapeHtml(platform.platform.toLowerCase())}">${escapeHtml(platform.platform)}</span><h2>${escapeHtml(entry.label ?? pair.name ?? 'Unnamed result')}</h2></div><div class="links">${link(outputDir, 'Comparison', entry.reportFile, true)}${link(outputDir, 'pair.json', entry.pairFile)}${link(outputDir, 'comparison.json', entry.comparisonFile)}</div></header>
    <p class="description">${escapeHtml(pair.testDescription ?? 'No test description recorded.')}</p>
    <p><b>Result:</b> ${escapeHtml(pair.reason ?? 'No result reason recorded.')}</p>
    <div class="meta"><span>${escapeHtml(pair.startedAt ?? '')}</span><span>${escapeHtml(pair.environment?.name ?? '')}</span><span>${escapeHtml(deviceLabel)}</span><span>${escapeHtml(tags.join(' · '))}</span></div>
    ${metrics}
    <div class="videos">${videoPanel(outputDir, 'Direct browser baseline', entry.baseline, 'baseline')}${videoPanel(outputDir, 'Popcorn LiveView', entry.candidate, 'candidate')}</div>
  </article>`;
}

function entrySpecPath(spec, baseDir) {
  const relative = typeof spec === 'string' ? spec : spec.manifest;
  if (!relative) throw new Error('Every dashboard entry requires a manifest path');
  return path.resolve(baseDir, relative);
}

export function buildDashboard({ configFile, manifests = [], outputFile, skipMissing = false }) {
  const configPath = configFile ? path.resolve(configFile) : null;
  const config = configPath
    ? readJson(configPath, 'dashboard config')
    : { schemaVersion: 1, title: 'Popcorn LiveView mobile evidence', description: 'Explicitly selected results.', entries: [] };
  if (config.schemaVersion !== 1) throw new Error('Dashboard config schemaVersion must be 1');
  const configDir = configPath ? path.dirname(configPath) : process.cwd();
  const specs = [...(config.entries ?? []), ...manifests];
  // A listed manifest that cannot be read is an error: the selection is
  // explicit on purpose. `skipMissing` covers only the one case where that is
  // unhelpful - a manifest whose file is gone, which cannot be rendered at all -
  // and every skip is reported in the page and in dashboard-manifest.json
  // rather than dropped quietly.
  const skipped = [];
  const kept = [];
  for (const spec of specs) {
    const file = entrySpecPath(spec, configDir);
    if (skipMissing && !existsSync(file)) {
      skipped.push({ manifest: path.relative(configDir, file), label: typeof spec === 'object' ? spec.label ?? null : null });
      continue;
    }
    kept.push(spec);
  }
  const entries = kept.map((spec) => loadEntry(spec, configDir));
  const absoluteOutput = path.resolve(outputFile ?? path.join(root, 'artifacts', 'index.html'));
  const outputDir = path.dirname(absoluteOutput);
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const counts = Object.groupBy(entries, (entry) => entry.pair.verdict ?? entry.pair.status ?? 'REVIEW');
  const platformCounts = Object.groupBy(entries, (entry) => platformDetails(entry).platform);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(config.title)}</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#e5e7eb;background:#080b12}*{box-sizing:border-box}body{margin:0;background:linear-gradient(145deg,#080b12,#111827 55%,#172554);min-height:100vh}main{width:min(1500px,calc(100% - 28px));margin:auto;padding:30px 0 60px}.hero,.result{border:1px solid #334155;border-radius:18px;background:#0f172aed;box-shadow:0 20px 55px #0005}.hero{padding:26px}.eyebrow{color:#67e8f9;font-size:12px;font-weight:900;letter-spacing:.12em;text-transform:uppercase}h1{margin:8px 0}.hero p,.meta{color:#94a3b8}.summary{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}.summary span{padding:9px 12px;border:1px solid #334155;border-radius:10px;background:#111827}.toolbar{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:10px;padding:14px 0;background:#0b1020e8;backdrop-filter:blur(10px)}input,select{border:1px solid #475569;border-radius:9px;background:#111827;color:white;padding:10px 12px;font:inherit}input{flex:1}.visible-count{min-width:max-content;color:#94a3b8;font-size:13px}.results{display:grid;gap:18px}.result{padding:20px;min-width:0;overflow:hidden}.result header{display:flex;justify-content:space-between;gap:14px}.result-title{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.result h2{display:inline;margin:0;font-size:21px}.badge,.platform{padding:6px 9px;border-radius:999px;font-size:12px;font-weight:900}.badge-pass{background:#166534}.badge-fail{background:#991b1b}.badge-review{background:#475569}.badge-infra_error{background:#92400e}.platform{border:1px solid #475569;background:#1e293b}.platform-android{border-color:#4ade80;color:#bbf7d0}.platform-ios{border-color:#60a5fa;color:#bfdbfe}.description{padding:10px 12px;border-left:4px solid #22d3ee;background:#0c4a6e55}.meta,.links{display:flex;flex-wrap:wrap;gap:10px}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:14px 0}.metrics div,.video{padding:12px;border:1px solid #334155;border-radius:12px;background:#020617}.metrics b{display:block;font-size:22px}.metrics span{color:#94a3b8}.videos{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:14px}body[data-evidence-view="baseline"] .video[data-view="candidate"],body[data-evidence-view="candidate"] .video[data-view="baseline"]{display:none}body[data-evidence-view="baseline"] .videos,body[data-evidence-view="candidate"] .videos{grid-template-columns:1fr}.video video{display:block;width:100%;max-height:620px;background:#000;border-radius:8px}.video h3{margin-top:0}.video .links{margin-top:9px}.missing{display:flex;min-height:180px;flex-direction:column;justify-content:center;color:#94a3b8}a{color:#93c5fd;text-decoration:none}a:hover{text-decoration:underline}a.primary{padding:7px 10px;border-radius:8px;background:#2563eb;color:white;font-weight:800}.hero.skipped{margin-bottom:18px;border-color:#92400e;background:#78350f55}.hero.skipped ul{margin:8px 0 0;padding-left:20px}.empty{padding:50px 20px;text-align:center;border:1px dashed #475569;border-radius:16px;color:#94a3b8}@media(max-width:900px){.result header{display:block}.result header .links{margin-top:12px}.metrics,.videos{grid-template-columns:1fr}.toolbar{align-items:stretch;flex-direction:column}.visible-count{padding:0 4px}}
</style></head><body><main>
${skipped.length ? `<section class="hero skipped"><div class="eyebrow">Missing manifests</div><p><b>${skipped.length}</b> selected ${skipped.length === 1 ? 'result was' : 'results were'} not rendered because ${skipped.length === 1 ? 'its manifest file' : 'their manifest files'} no longer exist:</p><ul>${skipped.map((entry) => `<li>${escapeHtml(entry.label ?? entry.manifest)} <span class="meta">${escapeHtml(entry.manifest)}</span></li>`).join('')}</ul></section>` : ''}
<section class="hero"><div class="eyebrow">Explicit manifest dashboard</div><h1>${escapeHtml(config.title)}</h1><p>${escapeHtml(config.description ?? '')}</p><div class="summary"><span><b>${entries.length}</b> selected results</span><span><b>${platformCounts.iOS?.length ?? 0}</b> iOS</span><span><b>${platformCounts.Android?.length ?? 0}</b> Android</span><span><b>${counts.PASS?.length ?? 0}</b> pass</span><span><b>${counts.FAIL?.length ?? 0}</b> fail</span><span><b>${counts.REVIEW?.length ?? 0}</b> review</span><span><b>${counts.INFRA_ERROR?.length ?? 0}</b> infrastructure errors</span></div></section>
<div class="toolbar"><input id="search" type="search" aria-label="Search results" placeholder="Filter selected results"><select id="platform" aria-label="Platform"><option value="">All platforms</option><option>iOS</option><option>Android</option><option>Unknown</option></select><select id="verdict" aria-label="Verdict"><option value="">All verdicts</option><option>PASS</option><option>FAIL</option><option>REVIEW</option><option>INFRA_ERROR</option></select><select id="evidence-view" aria-label="Evidence view"><option value="both">Both views</option><option value="baseline">Browser only</option><option value="candidate">Popcorn only</option></select><output id="visible-count" class="visible-count"></output></div>
<section class="results" id="results">${entries.length ? entries.map((entry) => card(outputDir, entry)).join('') : '<p class="empty">No result manifests were selected. Add entries to a dashboard config or pass --manifest.</p>'}</section>
</main><script>
const search=document.querySelector('#search');const platform=document.querySelector('#platform');const verdict=document.querySelector('#verdict');const evidenceView=document.querySelector('#evidence-view');const visibleCount=document.querySelector('#visible-count');const cards=[...document.querySelectorAll('.result')];function apply(){const q=search.value.trim().toLowerCase();const p=platform.value;const v=verdict.value;let shown=0;for(const card of cards){card.hidden=Boolean((q&&!card.dataset.search.includes(q))||(p&&card.dataset.platform!==p)||(v&&card.dataset.verdict!==v));if(!card.hidden)shown+=1;}document.body.dataset.evidenceView=evidenceView.value;visibleCount.textContent='Showing '+shown+' of '+cards.length;}search.addEventListener('input',apply);platform.addEventListener('change',apply);verdict.addEventListener('change',apply);evidenceView.addEventListener('change',apply);apply();
</script></body></html>`;
  writeFileSync(absoluteOutput, html, { mode: 0o600 });
  const buildManifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    config: configPath ? path.relative(outputDir, configPath) : null,
    output: path.basename(absoluteOutput),
    entries: entries.map((entry) => path.relative(outputDir, entry.pairFile)),
    skippedEntries: skipped,
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
      'skip-missing': { type: 'boolean' },
    },
  });
  try {
    buildDashboard({
      configFile: args.values.config,
      manifests: args.values.manifest ?? [],
      outputFile: args.values.output,
      skipMissing: Boolean(args.values['skip-missing']),
    });
  } catch (error) {
    console.error(error.stack || error);
    process.exit(1);
  }
};
