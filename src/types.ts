import { DynamicModule, Type } from '@nestjs/common';
import { FilterQuery, Schema, UpdateQuery } from 'mongoose';
import { Observable } from 'rxjs';

/**
 * Reemplaza esta interfaz por tu BaseOrmOptions real (la que ya tienes en
 * `../../../types`) si quieres tipado estricto. La dejamos abierta para que
 * la librería no dependa de tu monorepo.
 */
export interface BaseOrmOptions {
    [key: string]: any;
}

export type RepositoryQueryTarget = 'main' | 'cache';

export interface CacheConnectionConfig {
    /** Nombre de la conexión de caché (igual que usas hoy con ConnectionNames). */
    connectionName: string;
    /** Segundos que un documento debe vivir en la conexión de caché (índice TTL). */
    ttlSeconds: number;
}

export interface BackupConnectionConfig {
    /** Nombre de la conexión de respaldo (solo-escritura). */
    connectionName: string;
}

export interface BackupSyncConfig {
    /** Si en false, nadie sincroniza automáticamente (puedes llamar syncNow() tú mismo desde un microservicio). */
    enabled: boolean;
    /** Cada cuánto (ms) se revisa main vs backups. Default: 60000 (1 min). */
    intervalMs?: number;
    /** Si debe correr una verificación inmediatamente al arrancar el módulo. Default: false. */
    runOnStart?: boolean;
    /** Cuántos documentos procesar por lote en cada verificación. Default: 500. */
    batchSize?: number;
}

export interface PendingOpsConfig {
    /** Cada cuánto (ms) se reintentan las escrituras pendientes hacia cache/backups. Default: 5000. */
    retryIntervalMs?: number;
    /** Máximo de operaciones pendientes en memoria por conexión secundaria antes de descartar la más vieja. Default: 1000. */
    maxQueueSize?: number;
}

export interface FindOptions {
    /**
     * 'cache' | 'main'. Si no se especifica:
     *  - Si hay conexión de caché configurada -> intenta caché, si no encuentra (o si la caché
     *    está caída) cae a main.
     *  - Si no hay caché -> consulta main directamente.
     * Si se especifica explícitamente, NO hace fallback ni repuebla caché.
     */
    target?: RepositoryQueryTarget;
    sort?: Record<string, 1 | -1>;
    limit?: number;
    skip?: number;
    projection?: Record<string, 0 | 1>;
}

export interface UpdateManyResult {
    matched: number;
    modified: number;
}

/**
 * Contrato público que debe cumplir cualquier servicio de repositorio:
 * tanto `BaseRepositoryService` (el que se usa por defecto) como cualquier
 * servicio personalizado que pases en `RepositoryModuleOptions.customService`.
 *
 * Si decides implementar tu propio servicio en vez de usar
 * `BaseRepositoryService`, esta es la interfaz que tu clase tiene que
 * cumplir — TypeScript te lo exige apenas la asignas a `customService`.
 */
export interface IBaseRepositoryService<T = any> {
    findOne(filter: FilterQuery<T>, opts?: FindOptions): Observable<T | null>;
    find(filter?: FilterQuery<T>, opts?: FindOptions): Observable<T[]>;
    create(dto: Partial<T>): Observable<T>;
    insertMany(dtos: Partial<T>[]): Observable<T[]>;
    updateOne(filter: FilterQuery<T>, update: UpdateQuery<T>): Observable<T | null>;
    updateMany(filter: FilterQuery<T>, update: UpdateQuery<T>): Observable<UpdateManyResult>;
    deleteOne(filter: FilterQuery<T>): Observable<boolean>;
    deleteMany(filter: FilterQuery<T>): Observable<number>;
    count(filter?: FilterQuery<T>): Observable<number>;
    aggregate<R = any>(pipeline: any[]): Observable<R[]>;
    updateObject(object: any): Observable<T | null>;
    upsertBulk(bulkData: any[]): Observable<any>;
    updateBulk(bulkData: any[]): Observable<any>;
}

export interface RepositoryModuleOptions<T> {
    /** Clase de la entidad (la misma que hoy pasas a `super(model, Position, options)`). */
    entity: Type<T>;
    /** Schema de mongoose de la entidad. */
    schema: Schema;
    /** Conexión principal (ej. ConnectionNames.OPERATION_MDB). */
    connectionName: string;
    /** Opciones equivalentes a tu BaseOrmOptions actual. */
    options?: BaseOrmOptions;
    /** Conexión de caché opcional, con su propio TTL. */
    cache?: CacheConnectionConfig;
    /** Conexiones de respaldo, solo-escritura (réplicas completas de main). */
    backups?: BackupConnectionConfig[];
    /** Configuración de la verificación periódica de los backups contra main. */
    backupSync?: BackupSyncConfig;
    /**
     * Configuración de la cola de reintentos para cache/backups. Si una de
     * estas conexiones está caída o no lista, las escrituras quedan
     * pendientes aquí en vez de fallar, y se reintentan solas.
     */
    pendingOps?: PendingOpsConfig;
    /**
     * Servicio personalizado a usar en vez de `BaseRepositoryService`. Debe
     * ser una clase que, al instanciarla, cumpla `IBaseRepositoryService<T>`
     * (TypeScript te lo exige al asignarla aquí). Si no la pasas, se usa
     * `BaseRepositoryService` por defecto.
     *
     * Recomendado: extiende `BaseRepositoryService<T>` y llama `super(...)`
     * con los mismos argumentos que recibe tu constructor — así heredas toda
     * la resiliencia de caché/backups y solo sobreescribes lo que te
     * interese. Ver `examples/custom-repository-service.example.ts`.
     */
    customService?: Type<IBaseRepositoryService<T>>;
}

/**
 * Lo que retorna RepositoryOrmModule.register(...). Es un DynamicModule normal
 * de Nest + el atributo REPOSITORY_SERVICE_KEY que necesita @RepositoryInject().
 */
export interface RepositoryDynamicModule extends DynamicModule {
    REPOSITORY_SERVICE_KEY: string;
}