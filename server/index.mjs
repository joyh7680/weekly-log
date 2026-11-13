import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { createApp } from './app.mjs'

if (existsSync('.env')) process.loadEnvFile('.env')
const { app, store } = createApp({ dataDir: resolve(process.env.DATA_DIR || 'data') })
const port = Number(process.env.PORT || 4310), host = process.env.HOST || '127.0.0.1'
const server = app.listen(port, host, () => console.log(`Weekly Log ready: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`))
function stop() { server.close(() => { store.close(); process.exit(0) }) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
