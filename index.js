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
    if (config.filterTools.length) console.log(`  filtered tools: ${config.filterTools.join(', ')}`)
    if (config.bypassAppDetailMessage) console.log('  bypass: dropping <application_details> system messages')
  } catch (err) {
    console.error(`Failed to start: ${err.message}`)
    process.exit(1)
  }
}

start()
