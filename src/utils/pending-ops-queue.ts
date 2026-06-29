import { Logger } from '@nestjs/common';
import { Connection } from 'mongoose';

export type PendingOperation = () => Promise<void>;

interface QueueItem {
    label: string;
    run: PendingOperation;
    attempts: number;
    enqueuedAt: Date;
}

/**
 * Cola en memoria de operaciones que no se pudieron aplicar de inmediato en
 * una conexión secundaria (caché o backup) porque la conexión no estaba
 * lista o la operación falló. Se reintenta periódicamente y, además,
 * apenas la conexión emite el evento `connected`.
 *
 * Las operaciones que se encolan aquí son siempre upserts/deletes por `_id`
 * (idempotentes), así que reintentarlas en orden FIFO, incluso varias
 * veces, es seguro.
 *
 * Nota: esta cola vive en memoria del proceso. Si el proceso se reinicia
 * mientras hay operaciones pendientes, se pierden — pero no hay pérdida de
 * datos real, porque `BackupSyncService` (para backups) vuelve a poner al
 * día cualquier backup comparando contra `main` en su próxima corrida. Para
 * la caché, un siguiente `find`/`findOne` simplemente la repuebla.
 */
export class PendingOpsQueue {
    protected readonly logger: Logger;
    protected queue: QueueItem[] = [];
    protected flushing = false;
    protected timer?: NodeJS.Timeout;

    constructor(
        protected readonly label: string,
        protected readonly intervalMs = 5000,
        protected readonly maxQueueSize = 1000,
    ) {
        this.logger = new Logger(`PendingOps:${label}`);
    }

    size(): number {
        return this.queue.length;
    }

    enqueue(run: PendingOperation, opLabel = this.label): void {
        if (this.queue.length >= this.maxQueueSize) {
            const dropped = this.queue.shift();
            this.logger.warn(
                `Cola llena (${this.maxQueueSize}), se descarta la operación pendiente más antigua (${dropped?.label}).`,
            );
        }
        this.queue.push({ label: opLabel, run, attempts: 0, enqueuedAt: new Date() });
    }

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => {
            this.flush().catch((err) => this.logger.error(err));
        }, this.intervalMs);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }

    /** Reintenta de inmediato apenas la conexión vuelve a estar disponible, sin esperar al siguiente tick del timer. */
    watchConnection(connection: Connection): void {
        connection.on('connected', () => {
            this.flush().catch((err) => this.logger.error(err));
        });
    }

    async flush(): Promise<void> {
        if (this.flushing || !this.queue.length) return;
        this.flushing = true;

        try {
            const pending = this.queue;
            this.queue = [];

            for (const item of pending) {
                try {
                    await item.run();
                } catch (err) {
                    item.attempts += 1;
                    this.queue.push(item); // se reintenta en la próxima pasada
                    this.logger.debug(
                        `Reintento fallido (#${item.attempts}) para "${item.label}": ${(err as Error)?.message}`,
                    );
                }
            }
        } finally {
            this.flushing = false;
        }
    }
}