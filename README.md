**Language:** English · [Español](./README.es.md)

# @deorta/nestjs-repository-core

A NestJS + Mongoose library that generates a generic repository service
(`BaseRepositoryService<T>`) for any entity — with read-through caching and
write-only backup replicas — **without having to write an `XxxOrmService` /
`XxxOrmModule` class per entity**.

Replaces the per-entity `PositionOrmService` + `PositionOrmModule` pattern
with a single `RepositoryOrmModule.register(...)` call.

Built and verified with `tsc --strict` against `@nestjs/common`,
`@nestjs/mongoose`, `mongoose` and `class-transformer`.

## Installation

```bash
npm install @deorta/nestjs-repository-core
```

You also need these installed (they're `peerDependencies`, not installed
automatically):

```bash
npm install @nestjs/common @nestjs/mongoose mongoose class-transformer reflect-metadata rxjs
```

## Basic usage

```ts
import { RepositoryOrmModule, RepositoryInject, IBaseRepositoryService } from '@deorta/nestjs-repository-core';

// position-repository.module.ts
export const PositionRepositoryModule = RepositoryOrmModule.register({
  entity: Position,
  schema: positionSchema,
  connectionName: ConnectionNames.OPERATION_MDB,
});

// in any @Module:
@Module({ imports: [PositionRepositoryModule] })
export class SomeModule {}

// in any service: inject against the INTERFACE, not the concrete class
// (so swapping in a customService later doesn't require touching this).
constructor(
  @RepositoryInject(PositionRepositoryModule)
  private readonly positionRepository: IBaseRepositoryService<Position>,
) {}
```

The injection token is always `${Entity.name}RepositoryService` (e.g.
`PositionRepositoryService`), so it doesn't matter how many times you call
`.register()` for the same entity — the token is consistent, and
`@RepositoryInject(whateverRegisterReturned)` always resolves to the same
provider.

See `src/examples/position-repository.example.ts` for a complete migration
example using `Position`.

## `BaseRepositoryService<T>` API (the `IBaseRepositoryService<T>` contract)

| Method | What it does |
|---|---|
| `findOne(filter, opts?)` | Cache-first by default; falls back to `main` on a miss. `opts.target = 'main' \| 'cache'` forces a specific connection (no fallback). |
| `find(filter, opts?)` | Same as `findOne` but returns a list. Supports `opts.sort/limit/skip/projection`. |
| `create(dto)` | Inserts into `main`; the resulting document (with its `_id`) is replicated to cache and all backups. |
| `insertMany(dtos[])` | Same as `create`, in bulk (`insertMany` + `bulkWrite` against cache/backups). |
| `updateOne(filter, update)` | Updates `main` first, then replicates the resulting document to cache and backups. |
| `updateMany(filter, update)` | Same, in bulk. |
| `deleteOne(filter)` / `deleteMany(filter)` | Deletes from `main` first, then from cache and backups, and records a "tombstone" so periodic sync knows about it too. |

## Resilience: what happens if cache or backups are down?

**As long as `main` is up, the service works** — regardless of the state of
`cache` or any `backup` connection.

- **Reads (`findOne`/`find`)**: if the cache connection isn't ready or the
  query fails, it's treated as a cache miss and `main` is queried directly —
  the error never propagates.
- **Writes (`create`/`insertMany`/`updateOne`/`updateMany`/`deleteOne`/`deleteMany`)**:
  always run against `main` first. Propagation to `cache` and each `backup`
  is attempted immediately; if a connection isn't ready (`readyState !== 1`)
  or the operation fails, **that write is queued in memory** (one queue per
  secondary connection) instead of failing the whole operation.
- The pending-ops queue retries itself:
    - Every `pendingOps.retryIntervalMs` (default 5000 ms).
    - As soon as the connection emits mongoose's `connected` event (immediate
      reaction, no need to wait for the next tick).
    - If more than `pendingOps.maxQueueSize` operations pile up (default
        1000) because a connection has been down for a while, the oldest ones
              are dropped to avoid unbounded memory growth — that's fine, because
              `BackupSyncService` catches backups up against `main` anyway, and for
              cache, the next `find`/`findOne` simply repopulates it.
- Queued operations are always `_id`-based upserts/deletes (idempotent), so
  retrying them in order, even multiple times, is safe.
- **Each backup is independent**: if you have two backups and one is down,
  the other keeps advancing with its own checkpoint; the one that was down
  catches up on its own once it's back (there's no shared checkpoint that
  one problematic connection can block).
- Tombstones (used to propagate deletes to backups) are only purged from
  the collection once **every** configured backup has already applied them
  — so a backup that was down doesn't lose the information it needs to
  catch up.

```ts
RepositoryOrmModule.register({
  // ...
  pendingOps: {
    retryIntervalMs: 5000, // how often pending writes are retried
    maxQueueSize: 1000,    // in-memory cap per secondary connection
  },
});
```

## Custom service (`customService`)

By default, `register(...)` uses `BaseRepositoryService`. If you need
different behavior for a particular entity, you can pass your own class via
`customService`:

```ts
RepositoryOrmModule.register({
  entity: Position,
  schema: positionSchema,
  connectionName: ConnectionNames.OPERATION_MDB,
  customService: PositionRepositoryService, // your class
});
```

`customService` is typed as `Type<IBaseRepositoryService<T>>`, so
**TypeScript won't let you assign a class that doesn't satisfy the
interface** (`findOne`, `find`, `create`, `insertMany`, `updateOne`,
`updateMany`, `deleteOne`, `deleteMany`, matching the exact
`IBaseRepositoryService<T>` signatures).

Two ways to write one (both shown in
`src/examples/custom-repository-service.example.ts`):

1. **Extend `BaseRepositoryService<T>`** (recommended): you inherit all the
   cache/backup resilience and only override the method(s) you care about,
   calling `super.method(...)` if you want to keep the original behavior.

   ```ts
   class PositionRepositoryService extends BaseRepositoryService<Position> {
     async create(dto: Partial<Position>) {
       const created = await super.create(dto);
       console.log('Position created:', created);
       return created;
     }
   }
   ```

2. **Implement `IBaseRepositoryService<T>` from scratch**: useful if you
   want a completely different strategy (e.g. skip cache/backups
   entirely). Its constructor must accept the same 9 parameters that
   `register(...)` already resolves for you: `entity, options, mainModel,
   cacheModel, cacheConfig, backupModels, backupLabels, tombstoneModel,
   pendingOpsConfig` (even if you don't use all of them).

Either way, you inject your custom service exactly like the default one,
with `@RepositoryInject(...)` — nothing else in your code changes, because
both satisfy `IBaseRepositoryService<T>`.

## `RepositoryOrmModule.register(...)` configuration reference

```ts
{
  entity: Position,            // entity class
  schema: positionSchema,      // mongoose schema
  connectionName: '...',       // main connection
  options: {},                 // your BaseOrmOptions

  cache: {                     // OPTIONAL
    connectionName: '...',
    ttlSeconds: 300,           // how long a document lives in the cache connection
  },

  backups: [                   // OPTIONAL, array of write-only connections
    { connectionName: '...' },
    { connectionName: '...' },
  ],

  backupSync: {                // OPTIONAL, only applies if `backups` is set
    enabled: true,              // if false, nothing syncs automatically
    intervalMs: 60_000,         // how often main vs. backups is checked
    runOnStart: true,           // run a check as soon as the module starts
    batchSize: 500,             // documents per batch per check
  },

  pendingOps: {                // OPTIONAL
    retryIntervalMs: 5000,
    maxQueueSize: 1000,
  },

  customService: PositionRepositoryService, // OPTIONAL, default: BaseRepositoryService
}
```

## Design notes

A few implementation choices worth knowing about if you're extending this
library:

1. **Cache vs. main on reads**: `findOne`/`find` without an explicit
   `target` query cache first and fall back to `main` on a miss (and
   repopulate cache in the background, without blocking the response).
   With `target: 'main'` or `target: 'cache'`, only that connection is
   queried, with no fallback.

2. **Cache TTL**: uses an "expire at a specific time" TTL index
   (`expireAfterSeconds: 0` on a `_cacheExpiresAt` field) instead of
   classic Mongo TTL, so every write can set its own expiration based on
   `cache.ttlSeconds`, independent of when the index was created.

3. **How backup catch-up is detected**: for inserts/updates, `updatedTime`
   is compared against a per-entity, per-backup checkpoint (this assumes
   your model keeps `updatedTime` current on every write). For deletes,
   instead of diffing the entire `_id` set (expensive at scale),
   `deleteOne`/`deleteMany` record a "tombstone" (`_id` + deletion time) on
   the `main` connection, which the sync process consumes and clears.
   > If your "deletes" are actually soft-deletes (a `trashed: true` flag),
   > the tombstone mechanism simply goes unused — `updatedTime`-based sync
   > already covers it, since flipping `trashed` also bumps `updatedTime`.

4. **Triggering backup sync**: by default, if `backupSync.enabled` is
   `true`, the service starts its own internal `setInterval`
   (`onModuleInit`/`onModuleDestroy`). If you'd rather have a lightweight
   external process decide when to sync, set `enabled: false` and call the
   public `syncNow()` method on `BackupSyncService` yourself (exposed as
   the `${Entity}BackupSyncService` provider) from wherever makes sense
   (an external cron, an endpoint, etc.).

5. **`BaseOrmOptions`** is intentionally left open
   (`{ [key: string]: any }`) so the library doesn't depend on any
   particular project's option shape. Define and use your own typed
   interface if you want strict typing.

6. **CRUD surface**: `findOne`/`find`, `create`/`insertMany`,
   `updateOne`/`updateMany`, `deleteOne`/`deleteMany` cover the most common
   operations. If you need more (`count`, `exists`, `aggregate`,
   pagination, etc.), add them to `IBaseRepositoryService`/
   `BaseRepositoryService` following the same cache/backup propagation
   pattern, or implement them in a `customService`.

## Known limitation

`updateMany` re-queries `main` with the original `filter` to know which
documents to propagate to cache/backups. If `update` changes a field that's
part of `filter` (e.g. `updateMany({ status: 'pending' }, { status: 'done'
})`), those documents will no longer match and won't be propagated
correctly. If this affects you, the workaround is to capture the affected
`_id`s *before* updating — you can do this by overriding `updateMany` in a
`customService`.

## License

MIT