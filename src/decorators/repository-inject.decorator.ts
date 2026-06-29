import { Inject } from '@nestjs/common';
import { RepositoryDynamicModule } from '../types';

/**
 * Inyecta el RepositoryService generado por `RepositoryOrmModule.register(...)`
 * sin tener que escribir `@Inject(modulo.REPOSITORY_SERVICE_KEY)` a mano.
 *
 * Uso:
 *
 *   export const PositionRepositoryModule = RepositoryOrmModule.register({ ... });
 *
 *   constructor(
 *     @RepositoryInject(PositionRepositoryModule)
 *     private readonly positionRepository: RepositoryService<Position>,
 *   ) {}
 *
 * No importa cuántas veces llames `.register()` para la misma entidad: el
 * token siempre es `${Entidad.name}RepositoryService`, así que cualquier
 * objeto retornado por register() para esa entidad sirve para inyectar.
 */
export function RepositoryInject(repositoryModule: RepositoryDynamicModule): ParameterDecorator {
    if (!repositoryModule || !repositoryModule.REPOSITORY_SERVICE_KEY) {
        throw new Error(
            '[RepositoryInject] El objeto recibido no proviene de RepositoryOrmModule.register(...) ' +
            '(no tiene REPOSITORY_SERVICE_KEY).',
        );
    }
    return Inject(repositoryModule.REPOSITORY_SERVICE_KEY);
}