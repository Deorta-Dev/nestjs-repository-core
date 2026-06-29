import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Model } from 'mongoose';
import { BackupSyncConfig } from '../types';

interface SyncOutcome {
    upserted: number;
    deleted: number;
}

/**
 * Revisa periódicamente qué le falta a cada conexión de backup respecto a
 * `main` y la pone al día:
 *   - Inserts/updates: documentos de `main` con `updatedTime` > checkpoint (uno por backup).
 *   - Deletes: usa la colección de tombstones (ver schema/tombstone.schema.ts), también con
 *     un checkpoint independiente por backup.
 *
 * Cada conexión de backup se sincroniza de forma INDEPENDIENTE: si una está
 * caída o falla, las demás igual avanzan, y la caída simplemente se pondrá
 * al día sola en una próxima corrida (no hay un único checkpoint compartido
 * que se bloquee por una conexión problemática).
 *
 * Si `backupSync.enabled` es `false`, este servicio no arranca ningún
 * temporizador interno: en ese caso eres tú (o un microservicio externo de
 * bajo esfuerzo) quien debe llamar `syncNow()` cuando le convenga.
 */
export class BackupSyncService implements OnModuleInit, OnModuleDestroy {
    protected readonly logger: Logger;
    protected timer?: NodeJS.Timeout;
    protected running = false;

    constructor(
        protected readonly entityName: string,
        protected readonly mainModel: Model<any>,
        protected readonly backupModels: Model<any>[],
        protected readonly backupLabels: string[],
        protected readonly tombstoneModel: Model<any>,
        protected readonly checkpointModel: Model<any>,
        protected readonly config: BackupSyncConfig,
    ) {
        this.logger = new Logger(`BackupSync:${entityName}`);
    }

    onModuleInit(): void {
        if (!this.config?.enabled || !this.backupModels.length) return;

        const interval = this.config.intervalMs ?? 60_000;
        this.timer = setInterval(() => {
            this.syncNow().catch((err) => this.logger.error(err));
        }, interval);

        if (this.config.runOnStart) {
            this.syncNow().catch((err) => this.logger.error(err));
        }
    }

    onModuleDestroy(): void {
        if (this.timer) clearInterval(this.timer);
    }

    /**
     * Dispara una verificación/actualización manual de TODOS los backups
     * configurados. Útil si prefieres que un microservicio externo (de bajo
     * esfuerzo) decida cuándo sincronizar, en vez del temporizador interno.
     */
    async syncNow(): Promise<SyncOutcome> {
        if (this.running) return { upserted: 0, deleted: 0 }; // evita solapamientos
        this.running = true;

        try {
            const batchSize = this.config?.batchSize ?? 500;

            const results = await Promise.allSettled(
                this.backupModels.map((backup, i) => this.syncBackup(backup, this.backupLabels[i], batchSize)),
            );

            const totals: SyncOutcome = { upserted: 0, deleted: 0 };
            results.forEach((result, i) => {
                if (result.status === 'fulfilled') {
                    totals.upserted += result.value.upserted;
                    totals.deleted += result.value.deleted;
                } else {
                    this.logger.warn(
                        `[${this.backupLabels[i]}] no se pudo sincronizar, se reintentará en la próxima corrida: ${
                            (result.reason as Error)?.message ?? result.reason
                        }`,
                    );
                }
            });

            // Solo borra tombstones que YA fueron aplicados en todos los backups (ver método).
            await this.purgeFullyAppliedTombstones();

            return totals;
        } finally {
            this.running = false;
        }
    }

    /** Sincroniza un backup específico. Si no está listo, falla rápido sin tocar `main`. */
    protected async syncBackup(backup: Model<any>, label: string, batchSize: number): Promise<SyncOutcome> {
        if (backup.db.readyState !== 1) {
            throw new Error(`conexión "${label}" no está lista (readyState=${backup.db.readyState})`);
        }

        const upserted = await this.syncUpsertsFor(backup, label, batchSize);
        const deleted = await this.syncDeletesFor(backup, label, batchSize);
        return { upserted, deleted };
    }

    protected async syncUpsertsFor(backup: Model<any>, label: string, batchSize: number): Promise<number> {
        const checkpointKey = this.upsertCheckpointKey(label);
        const checkpoint = await this.getCheckpoint(checkpointKey);

        const pending = await this.mainModel
            .find({ updatedTime: { $gt: checkpoint } } as any)
            .sort({ updatedTime: 1 })
            .limit(batchSize)
            .lean()
            .exec();

        if (!pending.length) return 0;

        await backup.bulkWrite(
            pending.map((doc: any) => ({
                replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true },
            })) as any,
        );

        const newCheckpoint = (pending[pending.length - 1] as any).updatedTime;
        await this.setCheckpoint(checkpointKey, newCheckpoint);

        return pending.length;
    }

    protected async syncDeletesFor(backup: Model<any>, label: string, batchSize: number): Promise<number> {
        if (!this.tombstoneModel) return 0;

        const checkpointKey = this.deleteCheckpointKey(label);
        const checkpoint = await this.getCheckpoint(checkpointKey);

        const tombstones = await this.tombstoneModel
            .find({ deletedAt: { $gt: checkpoint } } as any)
            .sort({ deletedAt: 1 })
            .limit(batchSize)
            .lean()
            .exec();

        if (!tombstones.length) return 0;

        const ids = tombstones.map((t: any) => t.docId);
        await backup.deleteMany({ _id: { $in: ids } } as any).exec();

        const newCheckpoint = (tombstones[tombstones.length - 1] as any).deletedAt;
        await this.setCheckpoint(checkpointKey, newCheckpoint);

        return tombstones.length;
    }

    /**
     * Un tombstone solo se borra de la colección una vez que TODOS los
     * backups configurados ya lo aplicaron (su checkpoint de deletes ya lo
     * superó). Así, un backup que estuvo caído puede ponerse al día más
     * tarde sin que el tombstone que necesitaba ya haya sido eliminado.
     */
    protected async purgeFullyAppliedTombstones(): Promise<void> {
        if (!this.tombstoneModel || !this.backupLabels.length) return;

        const checkpoints = await Promise.all(
            this.backupLabels.map((label) => this.getCheckpoint(this.deleteCheckpointKey(label))),
        );

        const minCheckpoint = checkpoints.reduce((min, c) => (c.getTime() < min.getTime() ? c : min), checkpoints[0]);
        if (!minCheckpoint || minCheckpoint.getTime() === 0) return;

        await this.tombstoneModel.deleteMany({ deletedAt: { $lte: minCheckpoint } } as any).exec();
    }

    protected upsertCheckpointKey(label: string): string {
        return `${this.entityName}:${label}:upsert`;
    }

    protected deleteCheckpointKey(label: string): string {
        return `${this.entityName}:${label}:delete`;
    }

    protected async getCheckpoint(key: string): Promise<Date> {
        const doc: any = await this.checkpointModel.findOne({ key }).lean().exec();
        return doc?.value ?? new Date(0);
    }

    protected async setCheckpoint(key: string, value: Date): Promise<void> {
        await this.checkpointModel
            .replaceOne({ key } as any, { key, value }, { upsert: true } as any)
            .exec();
    }
}