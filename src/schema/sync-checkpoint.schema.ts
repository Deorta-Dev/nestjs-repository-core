import { Schema } from 'mongoose';

/**
 * Guarda hasta qué `updatedTime` de `main` ya se sincronizó con los backups,
 * para que cada corrida de sincronización solo procese lo nuevo.
 */
export const syncCheckpointSchema = new Schema(
    {
        key: { type: String, required: true, unique: true },
        value: { type: Date, required: true },
    },
    { versionKey: false },
);