/**
 * ANTES (lo que tenías hoy):
 *   - position-orm.service.ts  -> una clase por entidad
 *   - position-orm.module.ts   -> un módulo por entidad
 *
 * AHORA: una sola línea por entidad, sin clases nuevas.
 */
import { RepositoryOrmModule, RepositoryInject, BaseRepositoryService } from '../';

// --- Estos tres imports son los tuyos reales en tu monorepo ---
// import { Position, positionSchema } from '../../../models';
// import { ConnectionNames } from '@mri/shared/consts';
// import { BaseOrmOptions } from '../../../types';

declare class Position {
    static name: string;
}
declare const positionSchema: any;
declare const ConnectionNames: { OPERATION_MDB: string; CACHE_MDB: string; BACKUP_MDB_1: string; BACKUP_MDB_2: string };

// 1) Defines el "módulo" de la entidad UNA vez (esto reemplaza PositionOrmModule.register(...))
export const PositionRepositoryModule = RepositoryOrmModule.register({
    entity: Position,
    schema: positionSchema,
    connectionName: ConnectionNames.OPERATION_MDB,

    // Opcional: conexión de caché (read-through), con TTL de 5 minutos.
    cache: {
        connectionName: ConnectionNames.CACHE_MDB,
        ttlSeconds: 300,
    },

    // Opcional: conexiones de respaldo, solo-escritura, réplica completa de main.
    backups: [{ connectionName: ConnectionNames.BACKUP_MDB_1 }, { connectionName: ConnectionNames.BACKUP_MDB_2 }],

    // Opcional: verificación periódica de que los backups estén al día con main.
    backupSync: {
        enabled: true, // ponlo en false si quieres delegar esto a un microservicio externo y llamar syncNow() tú mismo
        intervalMs: 60_000, // cada 1 minuto
        runOnStart: true,
        batchSize: 500,
    },
});

// 2) Lo importas en cualquier módulo de Nest como cualquier otro módulo:
//
// @Module({
//   imports: [PositionRepositoryModule],
//   providers: [SomeService],
// })
// export class SomeModule {}

// 3) Lo inyectas con @RepositoryInject(...) en vez de @Inject(token) a mano:
//
// @Injectable()
// export class SomeService {
//   constructor(
//     @RepositoryInject(PositionRepositoryModule)
//     private readonly positionRepository: RepositoryService<Position>,
//   ) {}
//
//   async getPosition(id: string) {
//     // Por defecto: intenta caché primero, si no está cae a main y repuebla la caché.
//     return this.positionRepository.findOne({ _id: id });
//   }
//
//   async getPositionFromMainOnly(id: string) {
//     return this.positionRepository.findOne({ _id: id }, { target: 'main' });
//   }
//
//   async createPosition(dto: Partial<Position>) {
//     // Crea en main, y propaga automáticamente a caché y a todos los backups.
//     return this.positionRepository.create(dto);
//   }
// }