import cluster from 'cluster'
import express from 'express'
import * as prometheus from 'prom-client'
import { Logger } from './logging'

const logger: Logger = console

const workers = Number(process.env.CLUSTER_WORKERS || 1)
const metricsPort = Number(process.env.METRICS_PORT || 6060)

if (workers === 1) {
    logger.log('Not using clustering, set CLUSTER_WORKERS env var to enable')
}

if (cluster.isMaster && workers > 1) {
    const aggregatorRegistry = new prometheus.AggregatorRegistry()
    if (workers > 1) {
        logger.log(`Forking ${workers} workers`)
        for (let i = 0; i < workers; i++) {
            cluster.fork()
        }
    }

    const metricsServer = express()
    metricsServer.get('/metrics', async (req, res, next) => {
        try {
            const metrics = await aggregatorRegistry.clusterMetrics()
            res.setHeader('Content-Type', aggregatorRegistry.contentType)
            res.end(metrics)
        } catch (err) {
            next(err)
        }
    })
    metricsServer.listen(metricsPort, () => {
        logger.log(`Prometheus metrics on http://localhost:${metricsPort}`)
    })
} else {
    require('./server.js')
}
