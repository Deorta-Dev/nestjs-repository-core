import { Schema } from 'mongoose';

/** Campo interno usado para el índice TTL en la conexión de caché. */
export const CACHE_EXPIRES_AT_FIELD = '_cacheExpiresAt';

/**
 * Clona el schema original y le agrega un campo + índice TTL para que Mongo
 * expire automáticamente los documentos de la conexión de caché.
 *
 * Usamos un índice TTL "a fecha exacta" (expireAfterSeconds: 0 sobre un campo
 * Date) en vez del clásico "expira N segundos después de creado", porque así
 * cada escritura puede definir su propio vencimiento (this.ttlSeconds) sin
 * depender de cuándo se creó el índice.
 */
export function withCacheTtl(originalSchema: Schema, _ttlSeconds: number): Schema {
    const cacheSchema = originalSchema.clone();
    cacheSchema.add({
        [CACHE_EXPIRES_AT_FIELD]: { type: Date },
    } as any);
    cacheSchema.index({ [CACHE_EXPIRES_AT_FIELD]: 1 }, { expireAfterSeconds: 0 });
    return cacheSchema;
}