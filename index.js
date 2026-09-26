#!/usr/bin/env node
// anthropen-proxy entry point: parse CLI/env config, start the server.

import { resolveConfig, HELP } from './src/config.js'
import { buildServer } from './src/server.js'

let config
try {
  config = resolveConfig(process.argv.slice(2), process.env)
} catch (err) {
  console.error(err.message)
  process.exit(err.exitCode ?? 1)
}

if (config.help) {
  console.log(HELP)
  process.exit(0)
}

const app = buildServer(config)

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

const start = async () => {
  try {
    await app.listen({ host: config.host, port: config.port })
    console.log(`anthropen-proxy listening on http://${config.host}:${config.port}`)
    if (!LOOPBACK.has(config.host)) {
      console.warn(
        `⚠ binding to ${config.host}: this proxy has NO authentication — anyone who can reach this address can use your backend model.`,
      )
    }
    console.log(`  backend:  ${config.baseUrl}/chat/completions`)
    console.log(`  model:    ${config.models.completion}`)
    console.log(`  reasoning: ${config.models.reasoning}`)
    console.log(`  timeout:  ${config.timeout / 1000}s (upstream inactivity)`)
    if (config.inboundKey) console.log('  inbound auth: REQUIRED (x-api-key / Authorization: Bearer)')
    if (config.filterTools.length) console.log(`  filtered tools: ${config.filterTools.join(', ')}`)
    if (config.bypassAppDetailMessage) console.log('  bypass: dropping <application_details> system messages')
  } catch (err) {
    console.error(`Failed to start: ${err.message}`)
    process.exit(1)
  }
}

// Graceful shutdown: stop accepting new connections and let in-flight
// requests finish. Hijacked streaming replies are not tracked by Fastify's
// idle accounting, so a hard cap force-exits if a long stream lingers.
let shuttingDown = false
const shutdown = (signal) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n${signal} received — shutting down (active streams get 5s to finish)...`)
  const force = setTimeout(() => process.exit(0), 5000)
  app
    .close()
    .then(() => {
      clearTimeout(force)
      process.exit(0)
    })
    .catch(() => process.exit(1))
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

start()
