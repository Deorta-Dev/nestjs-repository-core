import { Schema, SchemaTypes } from 'mongoose';

/**
 * Cada vez que se borra un documento en `main` (y existen backups
 * configurados), guardamos aquí su _id y la fecha de borrado. El
 * BackupSyncService lee estos registros para saber qué borrar en los
 * backups, sin tener que comparar el set completo de _ids contra main.
 */
export const tombstoneSchema = new Schema(
    {
        docId: { type: SchemaTypes.Mixed, required: true, index: true },
        deletedAt: { type: Date, default: () => new Date(), index: true },
    },
    { versionKey: false },
);