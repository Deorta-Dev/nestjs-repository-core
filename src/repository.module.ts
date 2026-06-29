import { DynamicModule, Module, Provider } from '@nestjs/common';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BaseRepositoryService } from './base-repository.service';
import { syncCheckpointSchema } from './schema/sync-checkpoint.schema';
import { tombstoneSchema } from './schema/tombstone.schema';
import { withCacheTtl } from './schema/with-cache-ttl';
import { BackupSyncService } from './sync/backup-sync.service';
import { RepositoryDynamicModule, RepositoryModuleOptions } from './types';
import { getBackupSyncToken, getRepositoryToken } from './utils';

/** Token interno usado para rellenar posiciones opcionales del factory (cache/tombstone) cuando no aplican. */
const NONE_TOKEN = '__REPOSITORY_NONE__';

@Module({})
export class RepositoryOrmModule {
    /**
     * Genera dinámicamente todo lo necesario (modelo de mongoose, servicio
     * genérico, infraestructura de caché/backups) para una entidad, sin que
     * tengas que crear una clase `XxxOrmService` / `XxxOrmModule` por entidad.
     *
     * El objeto retornado se importa como cualquier módulo de Nest, y además
     * trae `REPOSITORY_SERVICE_KEY` para usar con `@RepositoryInject(...)`.
     */
    static register<T>(opts: RepositoryModuleOptions<T>): RepositoryDynamicModule {
        const entityName = opts.entity.name;
        const serviceToken = getRepositoryToken(opts.entity);
        const mainModelToken = getModelToken(entityName, opts.connectionName);

        const imports: DynamicModule['imports'] = [
            MongooseModule.forFeature([{ name: entityName, schema: opts.schema }], opts.connectionName),
        ];

        // ---- Caché (read-through, con TTL) ----
        let cacheModelToken: string | undefined;
        if (opts.cache) {
            const cacheSchema = withCacheTtl(opts.schema, opts.cache.ttlSeconds);
            imports.push(MongooseModule.forFeature([{ name: entityName, schema: cacheSchema }], opts.cache.connectionName));
            cacheModelToken = getModelToken(entityName, opts.cache.connectionName);
        }

        // ---- Backups (solo-escritura) ----
        const backupModelTokens: string[] = [];
        const backupLabels: string[] = [];
        (opts.backups ?? []).forEach((backup) => {
            imports.push(MongooseModule.forFeature([{ name: entityName, schema: opts.schema }], backup.connectionName));
            backupModelTokens.push(getModelToken(entityName, backup.connectionName));
            backupLabels.push(backup.connectionName);
        });

        const hasBackups = (opts.backups ?? []).length > 0;

        // ---- Infraestructura de sincronización (tombstones + checkpoint), solo si hay backups ----
        let tombstoneModelToken: string | undefined;
        let checkpointModelToken: string | undefined;

        if (hasBackups) {
            const tombstoneName = `${entityName}Tombstone`;
            const checkpointName = `${entityName}SyncCheckpoint`;

            imports.push(
                MongooseModule.forFeature(
                    [{ name: tombstoneName, schema: tombstoneSchema, collection: `_repo_tombstones_${entityName.toLowerCase()}` }],
                    opts.connectionName,
                ),
                MongooseModule.forFeature(
                    [{ name: checkpointName, schema: syncCheckpointSchema, collection: '_repo_sync_checkpoints' }],
                    opts.connectionName,
                ),
            );

            tombstoneModelToken = getModelToken(tombstoneName, opts.connectionName);
            checkpointModelToken = getModelToken(checkpointName, opts.connectionName);
        }

        const providers: Provider[] = [
            { provide: NONE_TOKEN, useValue: undefined },
            {
                provide: serviceToken,
                useFactory: (
                    mainModel: Model<T>,
                    cacheModel: Model<T> | undefined,
                    tombstoneModel: Model<any> | undefined,
                    ...backupModels: Model<T>[]
                ) =>
                    new BaseRepositoryService<T>(
                        opts.entity,
                        opts.options ?? {},
                        mainModel,
                        cacheModel,
                        opts.cache,
                        backupModels,
                        backupLabels,
                        tombstoneModel,
                        opts.pendingOps ?? {},
                    ),
                inject: [mainModelToken, cacheModelToken ?? NONE_TOKEN, tombstoneModelToken ?? NONE_TOKEN, ...backupModelTokens],
            },
        ];

        // ---- BackupSyncService (opcional, solo si hay backups + backupSync configurado) ----
        if (hasBackups && opts.backupSync) {
            providers.push({
                provide: getBackupSyncToken(opts.entity),
                useFactory: (
                    mainModel: Model<T>,
                    tombstoneModel: Model<any>,
                    checkpointModel: Model<any>,
                    ...backupModels: Model<T>[]
                ) =>
                    new BackupSyncService(
                        entityName,
                        mainModel,
                        backupModels,
                        backupLabels,
                        tombstoneModel,
                        checkpointModel,
                        opts.backupSync!,
                    ),
                inject: [mainModelToken, tombstoneModelToken!, checkpointModelToken!, ...backupModelTokens],
            });
        }

        return {
            module: RepositoryOrmModule,
            imports,
            providers,
            exports: [serviceToken],
            REPOSITORY_SERVICE_KEY: serviceToken,
        };
    }
}