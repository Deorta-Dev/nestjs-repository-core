import { Logger, OnModuleDestroy, OnModuleInit, Type } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { FilterQuery, Model, QueryOptions, UpdateQuery } from 'mongoose';
import { CACHE_EXPIRES_AT_FIELD } from './schema';
import { BaseOrmOptions, CacheConnectionConfig, FindOptions, PendingOpsConfig, RepositoryQueryTarget, UpdateManyResult } from './types';
import { PendingOpsQueue } from './utils';
import { from, of, forkJoin, Observable } from 'rxjs';
import { map, mergeMap, tap, catchError } from 'rxjs/operators';

interface PropagationEntry {
    model: Model<any>;
    queue: PendingOpsQueue;
    label: string;
    op: () => Promise<any>;
}

/**
 * Reemplazo genérico de los antiguos `XxxOrmService` (ej. PositionOrmService).
 * Una sola clase sirve para cualquier entidad: la instancia la crea
 * `RepositoryOrmModule.register(...)`, tú nunca extiendes esta clase.
 *
 * Resiliencia: si la conexión de caché o alguna de backup no está lista o
 * falla al escribir, la operación sobre `main` se completa igual y la
 * escritura hacia esa conexión secundaria queda pendiente en una cola en
 * memoria que se reintenta sola (ver `utils/pending-ops-queue.ts`).
 */
export class BaseRepositoryService<T = any> implements OnModuleInit, OnModuleDestroy {
    protected readonly logger: Logger;
    protected readonly cacheLabel?: string;
    protected readonly cacheQueue?: PendingOpsQueue;
    protected readonly backupLabels: string[];
    protected readonly backupQueues: PendingOpsQueue[];

    constructor(
        protected readonly entity: Type<T>,
        protected readonly options: BaseOrmOptions,
        protected readonly mainModel: Model<T>,
        protected readonly cacheModel: Model<T> | undefined,
        protected readonly cacheConfig: CacheConnectionConfig | undefined,
        protected readonly backupModels: Model<T>[] = [],
        backupConnectionNames: string[] = [],
        protected readonly tombstoneModel: Model<any> | undefined,
        pendingOpsConfig: PendingOpsConfig = {},
    ) {
        this.logger = new Logger(`Repository:${entity.name}`);

        this.cacheLabel = this.cacheModel ? `${entity.name}:cache:${cacheConfig?.connectionName ?? 'cache'}` : undefined;
        this.cacheQueue = this.cacheModel
            ? new PendingOpsQueue(this.cacheLabel!, pendingOpsConfig.retryIntervalMs, pendingOpsConfig.maxQueueSize)
            : undefined;

        this.backupLabels = this.backupModels.map(
            (_, i) => `${entity.name}:backup:${backupConnectionNames[i] ?? i}`,
        );
        this.backupQueues = this.backupModels.map(
            (_, i) => new PendingOpsQueue(this.backupLabels[i], pendingOpsConfig.retryIntervalMs, pendingOpsConfig.maxQueueSize),
        );
    }

    onModuleInit(): void {
        if (this.cacheModel && this.cacheQueue) {
            this.cacheQueue.start();
            this.cacheQueue.watchConnection(this.cacheModel.db);
        }
        this.backupModels.forEach((backup, i) => {
            this.backupQueues[i].start();
            this.backupQueues[i].watchConnection(backup.db);
        });
    }

    onModuleDestroy(): void {
        this.cacheQueue?.stop();
        this.backupQueues.forEach((q) => q.stop());
    }

    // ----------------------------------------------------------------------
    // LECTURA
    // ----------------------------------------------------------------------

    findOne(filter: FilterQuery<T>, opts: FindOptions = {}): Observable<T | null> {
        const explicitTarget = opts.target;
        const shouldTryCache = !!this.cacheModel && (explicitTarget === 'cache' || !explicitTarget);

        let read$: Observable<any>;
        if (shouldTryCache) {
            read$ = this.tryCacheRead(() =>
                this.cacheModel!.findOne(filter as any, opts.projection as any).lean().exec(),
            ).pipe(
                mergeMap((cached) => {
                    if (cached) return of(cached);
                    if (explicitTarget === 'cache') return of(null);
                    return from(this.mainModel.findOne(filter as any, opts.projection as any).lean().exec()).pipe(
                        tap((fromMain) => {
                            if (fromMain && this.cacheModel) {
                                this.scheduleWriteToCache(fromMain);
                            }
                        })
                    );
                })
            );
        } else {
            read$ = from(this.mainModel.findOne(filter as any, opts.projection as any).lean().exec());
        }

        return read$.pipe(
            map((doc) => doc ? this.toEntity(doc) : null)
        );
    }

    find(filter: FilterQuery<T> = {}, opts: FindOptions = {}): Observable<T[]> {
        const explicitTarget = opts.target;
        const shouldTryCache = !!this.cacheModel && (explicitTarget === 'cache' || !explicitTarget);

        let read$: Observable<any[]>;
        if (shouldTryCache) {
            read$ = this.tryCacheRead(() =>
                this.applyCursorOptions(this.cacheModel!.find(filter as any, opts.projection as any), opts).lean().exec(),
            ).pipe(
                mergeMap((cached) => {
                    if (cached && cached.length) return of(cached);
                    if (explicitTarget === 'cache') return of([]);
                    return from(
                        this.applyCursorOptions(this.mainModel.find(filter as any, opts.projection as any), opts)
                            .lean()
                            .exec()
                    ).pipe(
                        tap((fromMain) => {
                            if (this.cacheModel && fromMain.length) {
                                fromMain.forEach((doc) => this.scheduleWriteToCache(doc));
                            }
                        })
                    );
                })
            );
        } else {
            read$ = from(
                this.applyCursorOptions(this.mainModel.find(filter as any, opts.projection as any), opts)
                    .lean()
                    .exec()
            );
        }

        return read$.pipe(
            map((docs) => docs.map((doc) => this.toEntity(doc)))
        );
    }

    count(filter: FilterQuery<T> = {}): Observable<number> {
        return from(this.mainModel.countDocuments(filter as any).exec());
    }

    aggregate<R = any>(pipeline: any[]): Observable<R[]> {
        return from(this.mainModel.aggregate(pipeline).exec());
    }

    // ----------------------------------------------------------------------
    // ESCRITURA: CREATE
    // ----------------------------------------------------------------------

    create(dto: Partial<T>): Observable<T> {
        return from(this.mainModel.create(dto as any)).pipe(
            map((created) => (created as any).toObject ? (created as any).toObject() : created),
            mergeMap((plain) =>
                this.propagate(this.buildSingleEntries(plain, 'upsert')).pipe(
                    map(() => this.toEntity(plain))
                )
            )
        );
    }

    insertMany(dtos: Partial<T>[]): Observable<T[]> {
        if (!dtos.length) return of([]);

        return from(this.mainModel.insertMany(dtos as any[])).pipe(
            map((created) => (created as any[]).map((doc) => (doc?.toObject ? doc.toObject() : doc))),
            mergeMap((plainDocs) =>
                this.propagate(this.buildBulkEntries(plainDocs, 'upsert')).pipe(
                    map(() => plainDocs.map((doc) => this.toEntity(doc)))
                )
            )
        );
    }

    // ----------------------------------------------------------------------
    // ESCRITURA: UPDATE
    // ----------------------------------------------------------------------

    updateOne(filter: FilterQuery<T>, update: UpdateQuery<T>): Observable<T | null> {
        return from(
            this.mainModel
                .findOneAndUpdate(filter as any, this.withUpdatedTime(update), { new: true } as QueryOptions)
                .lean()
                .exec()
        ).pipe(
            mergeMap((updated) => {
                if (!updated) return of(null);
                return this.propagate(this.buildSingleEntries(updated, 'upsert')).pipe(
                    map(() => this.toEntity(updated))
                );
            })
        );
    }

    updateMany(
        filter: FilterQuery<T>,
        update: UpdateQuery<T>,
    ): Observable<{ matched: number; modified: number }> {
        return from(this.mainModel.updateMany(filter as any, this.withUpdatedTime(update)).exec()).pipe(
            mergeMap((result) =>
                from(this.mainModel.find(filter as any).lean().exec()).pipe(
                    mergeMap((affected) =>
                        this.propagate(this.buildBulkEntries(affected, 'upsert')).pipe(
                            map(() => ({ matched: result.matchedCount, modified: result.modifiedCount }))
                        )
                    )
                )
            )
        );
    }

    updateObject(object: any): Observable<T | null> {
        const { _id, ...rest } = object;
        return this.updateOne({ _id } as any, rest);
    }

    upsertBulk(bulkData: any[]): Observable<any> {
        const ops = bulkData.map((data) => ({
            updateMany: {
                filter: data.query,
                update: data.document,
                upsert: true,
            },
        }));
        return from(this.mainModel.bulkWrite(ops as any));
    }

    updateBulk(bulkData: any[]): Observable<any> {
        const ops = bulkData.map((data) => ({
            updateMany: {
                filter: data.query,
                update: data.document,
            },
        }));
        return from(this.mainModel.bulkWrite(ops as any));
    }

    // ----------------------------------------------------------------------
    // ESCRITURA: DELETE
    // ----------------------------------------------------------------------

    deleteOne(filter: FilterQuery<T>): Observable<boolean> {
        return from(this.mainModel.findOne(filter as any).lean().exec()).pipe(
            mergeMap((doc: any) => {
                if (!doc) return of(false);
                return from(this.mainModel.deleteOne(filter as any).exec()).pipe(
                    mergeMap(() =>
                        this.propagate(this.buildSingleEntries(doc, 'delete')).pipe(
                            mergeMap(() => from(this.recordTombstone(doc._id))),
                            map(() => true)
                        )
                    )
                );
            })
        );
    }

    deleteMany(filter: FilterQuery<T>): Observable<number> {
        return from(this.mainModel.find(filter as any, { _id: 1 } as any).lean().exec()).pipe(
            mergeMap((docs: any[]) => {
                if (!docs.length) return of(0);
                return from(this.mainModel.deleteMany(filter as any).exec()).pipe(
                    mergeMap((result) =>
                        this.propagate(this.buildBulkEntries(docs, 'delete')).pipe(
                            mergeMap(() => forkJoin(docs.map((d) => from(this.recordTombstone(d._id))))),
                            map(() => result.deletedCount ?? 0)
                        )
                    )
                );
            })
        );
    }

    // ----------------------------------------------------------------------
    // PROPAGACIÓN RESILIENTE A CACHE/BACKUPS
    // ----------------------------------------------------------------------

    protected propagate(entries: PropagationEntry[]): Observable<void> {
        if (!entries.length) return of(undefined);

        return forkJoin(
            entries.map((entry) => {
                const guarded = this.guard(entry.model, entry.label, entry.op);
                return from(guarded()).pipe(
                    catchError((err) => {
                        this.logger.warn(`[${entry.label}] no disponible, la operación queda pendiente: ${(err as Error)?.message}`);
                        entry.queue.enqueue(guarded, entry.label);
                        return of(undefined);
                    })
                );
            })
        ).pipe(
            map(() => undefined)
        );
    }

    protected guard(model: Model<any>, label: string, op: () => Promise<any>): () => Promise<void> {
        return async () => {
            if (model.db.readyState !== 1) {
                throw new Error(`conexión "${label}" no está lista (readyState=${model.db.readyState})`);
            }
            await op();
        };
    }

    protected buildSingleEntries(doc: any, kind: 'upsert' | 'delete'): PropagationEntry[] {
        const entries: PropagationEntry[] = [];

        if (this.cacheModel && this.cacheQueue) {
            entries.push({
                model: this.cacheModel,
                queue: this.cacheQueue,
                label: this.cacheLabel!,
                op:
                    kind === 'upsert'
                        ? () => this.upsertInto(this.cacheModel!, this.withCacheExpiry(doc))
                        : () => this.cacheModel!.deleteOne({ _id: doc._id } as any).exec(),
            });
        }

        this.backupModels.forEach((backup, i) => {
            entries.push({
                model: backup,
                queue: this.backupQueues[i],
                label: this.backupLabels[i],
                op: kind === 'upsert' ? () => this.upsertInto(backup, doc) : () => backup.deleteOne({ _id: doc._id } as any).exec(),
            });
        });

        return entries;
    }

    protected buildBulkEntries(docs: any[], kind: 'upsert' | 'delete'): PropagationEntry[] {
        if (!docs.length) return [];
        const entries: PropagationEntry[] = [];
        const ids = docs.map((d) => d._id);

        if (this.cacheModel && this.cacheQueue) {
            entries.push({
                model: this.cacheModel,
                queue: this.cacheQueue,
                label: this.cacheLabel!,
                op:
                    kind === 'upsert'
                        ? () => this.bulkUpsertInto(this.cacheModel!, docs, true)
                        : () => this.cacheModel!.deleteMany({ _id: { $in: ids } } as any).exec(),
            });
        }

        this.backupModels.forEach((backup, i) => {
            entries.push({
                model: backup,
                queue: this.backupQueues[i],
                label: this.backupLabels[i],
                op:
                    kind === 'upsert'
                        ? () => this.bulkUpsertInto(backup, docs, false)
                        : () => backup.deleteMany({ _id: { $in: ids } } as any).exec(),
            });
        });

        return entries;
    }

    protected tryCacheRead<R>(fn: () => Promise<R>): Observable<R | undefined> {
        if (!this.cacheModel) return of(undefined);
        if (this.cacheModel.db.readyState !== 1) {
            this.logger.warn(`[${this.cacheLabel}] lectura falló, se usa main: conexión no está lista`);
            return of(undefined);
        }
        return from(fn()).pipe(
            catchError((err) => {
                this.logger.warn(`[${this.cacheLabel}] lectura falló, se usa main: ${(err as Error)?.message}`);
                return of(undefined);
            })
        );
    }

    protected scheduleWriteToCache(doc: any): void {
        if (!this.cacheModel || !this.cacheQueue) return;
        const guarded = this.guard(this.cacheModel, this.cacheLabel!, () =>
            this.upsertInto(this.cacheModel!, this.withCacheExpiry(doc)),
        );
        guarded().catch(() => this.cacheQueue!.enqueue(guarded, this.cacheLabel!));
    }

    protected withUpdatedTime(update: UpdateQuery<T>): UpdateQuery<T> {
        const current: any = update ?? {};
        return { ...current, $set: { ...(current.$set ?? {}), updatedTime: new Date() } } as UpdateQuery<T>;
    }

    protected async upsertInto(model: Model<T>, doc: any): Promise<void> {
        await model.replaceOne({ _id: doc._id } as any, doc, { upsert: true } as any).exec();
    }

    protected async bulkUpsertInto(model: Model<any>, docs: any[], isCache: boolean): Promise<void> {
        if (!docs.length) return;
        const ops = docs.map((doc) => ({
            replaceOne: {
                filter: { _id: doc._id },
                replacement: isCache ? this.withCacheExpiry(doc) : doc,
                upsert: true,
            },
        }));
        await model.bulkWrite(ops as any);
    }

    protected withCacheExpiry(doc: any): any {
        if (!this.cacheConfig?.ttlSeconds) return doc;
        return { ...doc, [CACHE_EXPIRES_AT_FIELD]: new Date(Date.now() + this.cacheConfig.ttlSeconds * 1000) };
    }

    protected async recordTombstone(id: any): Promise<void> {
        if (!this.tombstoneModel || !this.backupModels.length) return;
        await this.tombstoneModel.create({ docId: id, deletedAt: new Date() });
    }

    protected applyCursorOptions<Q extends { sort: Function; skip: Function; limit: Function }>(
        query: Q,
        opts: FindOptions,
    ): Q {
        let q = query;
        if (opts.sort) q = q.sort(opts.sort) as Q;
        if (opts.skip) q = q.skip(opts.skip) as Q;
        if (opts.limit) q = q.limit(opts.limit) as Q;
        return q;
    }

    protected toEntity(doc: any): T {
        return plainToInstance(this.entity, doc) as T;
    }
}