import { MongoClient, Db, MongoClientOptions } from 'mongodb'

/**
 * Singleton MongoDB client.
 *
 * BUILD-SAFE BY DESIGN: this module must never throw at import time, because
 * Next.js evaluates server modules during `next build` (and on Vercel the build
 * runs before env vars like MONGODB_URI are guaranteed present). We therefore:
 *   - read the URI lazily, inside getDb()/getClient(), not at module top level
 *   - only construct the MongoClient on first actual use
 *   - throw a clear runtime error if the URI is missing when a query is attempted
 *
 * In development we cache the client promise on `globalThis` so Next's hot reload
 * doesn't open a new connection on every change (avoids exhausting Atlas conns).
 */

// Recommended options for MongoDB Atlas on serverless (Vercel). The driver
// negotiates TLS automatically for mongodb+srv URIs.
const options: MongoClientOptions = {
  // Keep the pool small — serverless functions are short-lived and Atlas M0
  // caps connections. One or two per warm instance is plenty.
  maxPoolSize: 10,
  // Fail fast instead of hanging a request if Atlas is unreachable.
  serverSelectionTimeoutMS: 10_000,
}

const DB_NAME = 'grant_os'

// Cache the connection promise across hot reloads in dev.
declare global {
  // eslint-disable-next-line no-var
  var _mongoClientPromise: Promise<MongoClient> | undefined
}

let clientPromise: Promise<MongoClient> | undefined

function getClientPromise(): Promise<MongoClient> {
  const uri = process.env.MONGODB_URI
  if (!uri) {
    throw new Error(
      'MONGODB_URI is not set. Add it to .env.local (local) or the Vercel project env (deploy).'
    )
  }

  if (process.env.NODE_ENV === 'development') {
    // Reuse across HMR reloads.
    if (!global._mongoClientPromise) {
      global._mongoClientPromise = new MongoClient(uri, options).connect()
    }
    return global._mongoClientPromise
  }

  // Production: one promise per server instance.
  if (!clientPromise) {
    clientPromise = new MongoClient(uri, options).connect()
  }
  return clientPromise
}

export async function getClient(): Promise<MongoClient> {
  return getClientPromise()
}

export async function getDb(): Promise<Db> {
  const client = await getClientPromise()
  return client.db(DB_NAME)
}
