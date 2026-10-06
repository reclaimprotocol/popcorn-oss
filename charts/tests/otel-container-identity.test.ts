import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
function collectorConfig() {
  const result = Bun.spawnSync(['helm', 'template', 'test', 'charts/platform', '--set', 'otel.enabled=true,otel.exporter.grpcEndpoint=fixture:4317,clusterName=fixture-cluster'], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  const documents = result.stdout.toString().split(/^---\s*$/m).filter(value => value.trim()).map(value => Bun.YAML.parse(value) as any)
  return Bun.YAML.parse(documents.find(doc => doc.kind === 'ConfigMap' && doc.metadata.name === 'otel-agent-config').data['config.yaml']) as any
}

test('filelog establishes pod resource identity before Kubernetes enrichment', () => {
  const config = collectorConfig()
  const pipeline = config.service.pipelines['logs/browser']
  expect(pipeline.receivers).toEqual(['filelog/browser'])
  expect(pipeline.processors.indexOf('k8sattributes')).toBeLessThan(pipeline.processors.indexOf('transform/session'))
  const operators = config.receivers['filelog/browser'].operators
  const copies = operators.filter((operator: any) => operator.type === 'copy')
  for (const name of ['service.name', 'k8s.namespace.name', 'k8s.pod.name', 'k8s.pod.uid', 'k8s.container.name']) {
    expect(copies.some((operator: any) => operator.to === `resource["${name}"]`)).toBe(true)
  }
  expect(config.processors['resource/from-filepath'].attributes.every((attribute: any) => !attribute.from_attribute)).toBe(true)
})

test.skipIf(!process.env.OTEL_COLLECTOR_TEST_IMAGE)('real collector labels sidecar and legacy logs and applies the session boundary', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'popcorn-otel-identity-'))
  const name = `popcorn-otel-identity-${process.pid}`
  const config = collectorConfig()
  const uid = '7802690d-d4db-46ba-869c-abcd71ff80da'
  const bound = Date.now() - 5000
  const containers = ['browser-events', 'browser-runtime', 'ai-agent']
  const timestamp = (offset: number) => new Date(bound + offset).toISOString()
  for (const container of containers) {
    const folder = join(directory, 'pods', `default_browser-fleet-test_${uid}`, container)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, '0.log'), `${timestamp(-1000)} stdout F before-bind-${container}\n${timestamp(1000)} stdout F after-bind-${container}\n`)
  }
  // Replace only Kubernetes API enrichment with its annotation/label results.
  // Keep the chart's actual receiver, identity mapping, filtering and session guard.
  config.receivers['filelog/browser'].resource = {
    'agones.dev.role': 'gameserver',
    'popcorn.session.id': 'fixture-session',
    'popcorn.session.bound_at_unix_nano': String(BigInt(bound) * 1000000n),
  }
  config.extensions.file_storage.directory = '/tmp/otel-identity-storage'
  delete config.processors.k8sattributes
  const pipeline = config.service.pipelines['logs/browser']
  pipeline.processors = pipeline.processors.filter((processor: string) => processor !== 'k8sattributes')
  config.exporters = { debug: { verbosity: 'detailed' } }
  pipeline.exporters = ['debug']
  config.processors.batch.timeout = '200ms'
  writeFileSync(join(directory, 'config.yaml'), Bun.YAML.stringify(config))
  const collector = Bun.spawn(['docker', 'run', '--rm', '--name', name, '--user', '0', '-v', `${directory}/pods:/var/log/pods:ro`, '-v', `${directory}/config.yaml:/etc/otelcol-contrib/config.yaml:ro`, process.env.OTEL_COLLECTOR_TEST_IMAGE!, '--config=/etc/otelcol-contrib/config.yaml'], { stdout: 'pipe', stderr: 'pipe' })
  const stdout = new Response(collector.stdout).text()
  const stderr = new Response(collector.stderr).text()
  try {
    await Bun.sleep(4000)
    const stop = Bun.spawnSync(['docker', 'stop', name], { stdout: 'pipe', stderr: 'pipe' })
    await collector.exited
    const output = await stdout + await stderr
    expect(stop.exitCode, output).toBe(0)
    for (const container of containers) {
      expect(output).toContain(`service.name: Str(${container})`)
      expect(output).toContain(`k8s.container.name: Str(${container})`)
      expect(output).toContain(`before-bind-${container}`)
      expect(output).toContain(`after-bind-${container}`)
    }
    expect(output).toContain(`k8s.pod.uid: Str(${uid})`)
    expect(output.match(/session.id: Str\(fixture-session\)/g)).toHaveLength(3)
    for (const block of output.split(/LogRecord #\d+/).slice(1)) {
      if (/Body: Str\(before-bind-/.test(block)) expect(block).not.toContain('session.id: Str(fixture-session)')
      if (/Body: Str\(after-bind-/.test(block)) expect(block).toContain('session.id: Str(fixture-session)')
    }
  } finally {
    Bun.spawnSync(['docker', 'stop', name], { stdout: 'pipe', stderr: 'pipe' })
    rmSync(directory, { recursive: true, force: true })
  }
}, 20000)
