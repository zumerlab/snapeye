import { attachSnapEye, createSnapEyeHandler, type SnapEyeHealth } from '@zumer/snapeye'
import {
  createHttpArtifactStore,
  type ArtifactStore,
  type SnapEyeHealth as ClientSnapEyeHealth,
  type SnapEyeResult
} from '@zumer/snapeye/client'
import createLegacyHandler from '@zumer/snapeye/server'
import snapeye from '@zumer/snapeye/vite'
import type { Plugin } from 'vite'
import { snapdom } from '@zumer/snapdom'

const store: ArtifactStore = createHttpArtifactStore({
  endpoint: '/__snapeye',
  token: 'ephemeral-token'
})

const health: SnapEyeHealth = {
  status: 'ok',
  name: '@zumer/snapeye',
  version: '0.3.0',
  protocolVersion: 1,
  artifactRoot: '.snapeye',
  artifactRootResolved: null
}
const clientHealth: ClientSnapEyeHealth = health
void clientHealth

const api = attachSnapEye({
  snapdom,
  store,
  autoOnQuery: false
})

const result: Promise<SnapEyeResult> = api.diff('dashboard', '#dashboard', {
  runId: 'type_smoke_001',
  waitFor: '#loaded',
  stabilize: true,
  settle: false,
  settleTimeout: 1000
})

void api.record('menu', '.menu', { duration: 2000, waitFor: 250, stabilize: false })

void result.then(value => {
  if (value.status === 'ok' && value.operation === 'diff') {
    value.diff.changedRatio.toFixed(3)
  } else if (value.status === 'error') {
    value.error.code.toLowerCase()
  }
})

const plugin: Plugin = snapeye({
  root: '.snapeye',
  maxRuns: 20,
  client: { forwardConsole: true, errorOverlay: false, hotkey: 'S', hotkeyName: 'scratch' }
})
const bare: Plugin = snapeye({ client: { hotkey: false } })
void bare
void plugin
void createSnapEyeHandler()
void createLegacyHandler()
