import type { Plugin } from 'vite'
import type { Connect } from 'vite'
import { openDatabase, type DB } from '../store/db'
import { AppService } from './app-service'
import { join } from 'node:path'
import { DomainFailure } from '../shared/types'

let singleton: { db: DB; service: AppService } | null = null

function runtime(): { db: DB; service: AppService } {
  if (singleton) return singleton
  const dataDir = join(process.cwd(), 'data')
  const db = openDatabase(join(dataDir, 'gel.db'))
  const service = new AppService(db, dataDir)
  service.seedIfEmpty()
  singleton = { db, service }
  return singleton
}

/** 供测试直接调用：内存数据库 + 独立数据目录。 */
export function createService(db?: DB, dataDir?: string): AppService {
  const database = db ?? openDatabase(':memory:')
  return new AppService(database, dataDir ?? process.cwd())
}

function send(res: Connect.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function readBody(req: Connect.IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function apiPlugin(): Plugin {
  return {
    name: 'gel-workbench-api',
    configureServer(server) {
      server.middlewares.use('/api', async (req, res) => {
        const { service } = runtime()
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const path = url.pathname
        try {
          if (path === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true })
          if (path === '/api/casepack' && req.method === 'GET') return send(res, 200, { scenarios: service.casepackMeta() })
          if (path === '/api/projects' && req.method === 'GET') return send(res, 200, { projects: service.projectList() })
          if (path === '/api/projects/reseed' && req.method === 'POST') return send(res, 200, service.seedIfEmpty(true))
          if (path === '/api/export' && req.method === 'POST') {
            const body = JSON.parse(await readBody(req)) as { projectId: string }
            return send(res, 200, service.exportBundle(body.projectId))
          }
          if (path === '/api/import' && req.method === 'POST') {
            const body = JSON.parse(await readBody(req)) as { bundle: string; simulateCrashBeforeCommit?: boolean }
            return send(res, 200, service.importBundle(body.bundle, { simulateCrashBeforeCommit: body.simulateCrashBeforeCommit }))
          }
          if (path === '/api/roundtrip' && req.method === 'POST') {
            const body = JSON.parse(await readBody(req)) as { projectId: string }
            return send(res, 200, service.roundtrip(body.projectId))
          }
          const reviewM = path.match(/^\/api\/projects\/([^/]+)\/review$/)
          if (reviewM && req.method === 'GET') {
            const branch = url.searchParams.get('branch') ?? undefined
            const until = url.searchParams.get('until') ?? undefined
            return send(res, 200, service.review(decodeURIComponent(reviewM[1]), branch ?? undefined, until ?? undefined))
          }
          const imgM = path.match(/^\/api\/images\/([^/]+)\.png$/)
          if (imgM && req.method === 'GET') {
            const projectId = url.searchParams.get('projectId') ?? ''
            const png = service.imagePng(projectId, decodeURIComponent(imgM[1]))
            if (!png) return send(res, 404, { error: 'not_found' })
            res.statusCode = 200
            res.setHeader('content-type', 'image/png')
            res.setHeader('cache-control', 'no-store')
            res.end(Buffer.from(png))
            return
          }
          return send(res, 404, { error: 'not_found', path })
        } catch (e) {
          if (e instanceof DomainFailure) {
            return send(res, 422, { error: e.kind, kind: e.kind, message: e.message, diagnostics: e.diagnostics })
          }
          return send(res, 500, { error: 'internal', message: (e as Error).message })
        }
      })
    }
  }
}
