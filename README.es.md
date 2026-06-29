**Idioma:** Español · [English](./README.md)

# @deorta/nestjs-repository-core

Librería para NestJS + Mongoose que genera, para cualquier entidad, un
servicio de repositorio genérico (`BaseRepositoryService<T>`) con caché
read-through y réplicas de respaldo (backups), **sin tener que crear una
clase `XxxOrmService` / `XxxOrmModule` por cada entidad**.

Reemplaza el patrón de `PositionOrmService` + `PositionOrmModule` por entidad
con una sola llamada a `RepositoryOrmModule.register(...)`.

Compilado y verificado con `tsc --strict` contra `@nestjs/common`,
`@nestjs/mongoose`, `mongoose` y `class-transformer`.

## Instalación

```bash
npm install @deorta/nestjs-repository-core
```

Necesitas tener instalados (son `peerDependencies`, no se instalan solos):

```bash
npm install @nestjs/common @nestjs/mongoose mongoose class-transformer reflect-metadata rxjs
```

## Uso básico

```ts
import { RepositoryOrmModule, RepositoryInject, IBaseRepositoryService } from '@deorta/nestjs-repository-core';

// position-repository.module.ts
export const PositionRepositoryModule = RepositoryOrmModule.register({
  entity: Position,
  schema: positionSchema,
  connectionName: ConnectionNames.OPERATION_MDB,
});

// en cualquier @Module:
@Module({ imports: [PositionRepositoryModule] })
export class SomeModule {}

// en cualquier servicio: inyecta contra la INTERFAZ, no contra la clase concreta
// (así, si luego cambias a un customService, no tienes que tocar nada aquí).
constructor(
  @RepositoryInject(PositionRepositoryModule)
  private readonly positionRepository: IBaseRepositoryService<Position>,
) {}
```

El token de inyección siempre es `${Entidad.name}RepositoryService` (ej.
`PositionRepositoryService`), así que no importa cuántas veces llames
`.register()` para la misma entidad: el token es consistente y
`@RepositoryInject(loQueSeaQueDevolvióRegister)` siempre apunta al mismo
provider.

Ver `src/examples/position-repository.example.ts` para el ejemplo completo
migrando `Position`.

## API de `BaseRepositoryService<T>` (contrato `IBaseRepositoryService<T>`)

| Método | Qué hace |
|---|---|
| `findOne(filter, opts?)` | Por defecto: caché primero, si no encuentra cae a `main` y repuebla caché. `opts.target = 'main' \| 'cache'` para forzar una conexión específica (sin fallback). |
| `find(filter, opts?)` | Igual que `findOne` pero lista. Soporta `opts.sort/limit/skip/projection`. |
| `create(dto)` | Inserta en `main`; el documento resultante (con su `_id`) se replica en caché y en todos los backups. |
| `insertMany(dtos[])` | Igual que `create` pero en bulk (`insertMany` + `bulkWrite` hacia caché/backups). |
| `updateOne(filter, update)` | Actualiza `main` primero, luego replica el documento resultante en caché y backups. |
| `updateMany(filter, update)` | Igual en bulk. |
| `deleteOne(filter)` / `deleteMany(filter)` | Borra en `main` primero, luego en caché y backups, y registra un "tombstone" para que la sincronización periódica también lo sepa. |

## Resiliencia: ¿qué pasa si caché o backups están caídos?

**Si `main` funciona, el servicio funciona**, sin importar el estado de
`cache` o de los `backups`.

- **Lecturas (`findOne`/`find`)**: si la conexión de caché no está lista o la
  consulta falla, se trata como "cache miss" y se consulta `main`
  directamente — nunca se propaga el error.
- **Escrituras (`create`/`insertMany`/`updateOne`/`updateMany`/`deleteOne`/`deleteMany`)**:
  siempre se ejecutan en `main` primero. La propagación hacia `cache` y cada
  `backup` se intenta de inmediato; si una conexión no está lista
  (`readyState !== 1`) o la operación falla, **esa operación queda pendiente
  en una cola en memoria** (una por conexión secundaria) en vez de hacer
  fallar la operación completa.
- La cola de pendientes se reintenta sola:
    - Cada `pendingOps.retryIntervalMs` (default 5000 ms).
    - Apenas la conexión emite el evento `connected` de mongoose (reacción
      inmediata, no espera al próximo tick).
    - Si se acumulan más de `pendingOps.maxQueueSize` operaciones (default
        1000) porque una conexión estuvo caída mucho tiempo, se descartan las
              más antiguas para no consumir memoria indefinidamente — eso está bien
              porque, para backups, `BackupSyncService` los pone al día de todos
              modos comparando contra `main`; y para caché, el próximo `find`/`findOne`
              simplemente la repuebla.
- Las operaciones encoladas son siempre upserts/deletes por `_id`
  (idempotentes), así que reintentarlas en orden, incluso varias veces, es
  seguro.
- **Cada backup es independiente**: si tienes dos backups y uno está caído,
  el otro sigue avanzando con su propio checkpoint; el caído se pondrá al
  día solo cuando vuelva (no hay un checkpoint compartido que se bloquee por
  una sola conexión problemática).
- Los tombstones (usados para propagar deletes a los backups) solo se borran
  de la colección una vez que **todos** los backups configurados ya los
  aplicaron — así uno que estuvo caído no se queda sin la información que
  necesita para ponerse al día.

```ts
RepositoryOrmModule.register({
  // ...
  pendingOps: {
    retryIntervalMs: 5000, // cada cuánto se reintentan las operaciones pendientes
    maxQueueSize: 1000,    // tope en memoria por conexión secundaria
  },
});
```

## Servicio personalizado (`customService`)

Por defecto, `register(...)` usa `BaseRepositoryService`. Si necesitas una
lógica distinta para una entidad en particular, puedes pasar tu propia clase
en `customService`:

```ts
RepositoryOrmModule.register({
  entity: Position,
  schema: positionSchema,
  connectionName: ConnectionNames.OPERATION_MDB,
  customService: PositionRepositoryService, // tu clase
});
```

`customService` está tipado como `Type<IBaseRepositoryService<T>>`, así que
**TypeScript no te deja asignar ahí una clase que no cumpla la interfaz**
(`findOne`, `find`, `create`, `insertMany`, `updateOne`, `updateMany`,
`deleteOne`, `deleteMany`, con las firmas exactas de `IBaseRepositoryService<T>`).

Dos formas de escribirla (ambas en `src/examples/custom-repository-service.example.ts`):

1. **Extender `BaseRepositoryService<T>`** (recomendado): heredas toda la
   resiliencia de caché/backups y solo sobreescribes el método que te
   interese, llamando `super.metodo(...)` si quieres conservar el
   comportamiento original.

   ```ts
   class PositionRepositoryService extends BaseRepositoryService<Position> {
     async create(dto: Partial<Position>) {
       const created = await super.create(dto);
       console.log('Position creada:', created);
       return created;
     }
   }
   ```

2. **Implementar `IBaseRepositoryService<T>` desde cero**: útil si quieres
   una estrategia totalmente distinta (ej. ignorar caché/backups). El
   constructor que recibe debe aceptar los mismos 9 parámetros que
   `register(...)` ya resuelve por ti: `entity, options, mainModel,
   cacheModel, cacheConfig, backupModels, backupLabels, tombstoneModel,
   pendingOpsConfig` (aunque no los uses todos).

Sea cualquiera de las dos, inyectas tu servicio personalizado exactamente
igual que el default, con `@RepositoryInject(...)` — no cambia nada en el
resto de tu código, porque ambos cumplen `IBaseRepositoryService<T>`.

## Configuración de `RepositoryOrmModule.register(...)`

```ts
{
  entity: Position,            // clase de la entidad
  schema: positionSchema,      // schema de mongoose
  connectionName: '...',       // conexión principal
  options: {},                 // tus BaseOrmOptions actuales

  cache: {                     // OPCIONAL
    connectionName: '...',
    ttlSeconds: 300,           // TTL del documento en la conexión de caché
  },

  backups: [                   // OPCIONAL, array de conexiones de solo-escritura
    { connectionName: '...' },
    { connectionName: '...' },
  ],

  backupSync: {                // OPCIONAL, solo aplica si hay `backups`
    enabled: true,              // si es false, nadie sincroniza automáticamente
    intervalMs: 60_000,         // cada cuánto se revisa main vs backups
    runOnStart: true,           // corre una verificación apenas arranca el módulo
    batchSize: 500,             // documentos por lote en cada verificación
  },

  pendingOps: {                // OPCIONAL
    retryIntervalMs: 5000,
    maxQueueSize: 1000,
  },

  customService: PositionRepositoryService, // OPCIONAL, default: BaseRepositoryService
}
```

## Notas de diseño

Algunas decisiones de implementación que vale la pena conocer si vas a
extender la librería:

1. **Caché vs. main en lecturas**: `findOne`/`find` sin `target` explícito
   consultan primero caché y si no hay nada caen a `main` (y repueblan la
   caché en segundo plano, sin bloquear la respuesta). Con `target: 'main'`
   o `target: 'cache'` consultan *solo* esa conexión, sin fallback.

2. **TTL de caché**: usa un índice TTL "a fecha exacta"
   (`expireAfterSeconds: 0` sobre un campo `_cacheExpiresAt`) en vez del TTL
   clásico de Mongo, porque así cada escritura define su propio vencimiento
   según `cache.ttlSeconds`, sin depender de cuándo se creó el índice.

3. **Cómo se detecta qué le falta a un backup**: para inserts/updates se
   compara `updatedTime` contra un checkpoint guardado por entidad (asume
   que tu modelo mantiene `updatedTime` actualizado en cada escritura). Para
   deletes, en vez de comparar todo el set de `_id` (caro a escala),
   `deleteOne`/`deleteMany` registran un "tombstone" (`_id` + fecha de
   borrado) en la conexión `main`, y el sync lo consume y lo borra.
   > Si tus "deletes" en realidad son soft-deletes (un flag como
   > `trashed: true`), el mecanismo de tombstones simplemente no se usa —
   > la sincronización por `updatedTime` ya es suficiente, porque marcar
   > `trashed: true` también actualiza `updatedTime`.

4. **Disparo de la sincronización de backups**: por defecto, si
   `backupSync.enabled` es `true`, el propio servicio arranca un
   `setInterval` interno (`onModuleInit`/`onModuleDestroy`). Si prefieres que
   un proceso externo de bajo esfuerzo decida cuándo sincronizar, deja
   `enabled: false` y llama tú mismo al método público `syncNow()` del
   `BackupSyncService` (expuesto como provider `${Entidad}BackupSyncService`)
   desde donde quieras (cron externo, endpoint, etc.).

5. **`BaseOrmOptions`** se deja intencionalmente abierta
   (`{ [key: string]: any }`) para que la librería no dependa de la forma
   exacta de opciones de ningún proyecto en particular. Si quieres tipado
   estricto, define tu propia interfaz y úsala en su lugar.

6. **Superficie de CRUD**: `findOne`/`find`, `create`/`insertMany`,
   `updateOne`/`updateMany`, `deleteOne`/`deleteMany` cubren las operaciones
   más comunes. Si necesitas más (`count`, `exists`, `aggregate`,
   paginación, etc.), agrégalas a `IBaseRepositoryService`/
   `BaseRepositoryService` siguiendo el mismo patrón de propagación a
   caché/backups, o impleméntalas en un `customService`.

## Limitación conocida

En `updateMany`, para propagar a caché/backups se vuelve a consultar `main`
con el mismo `filter` original. Si el `update` cambia campos que forman
parte de ese `filter` (ej. `updateMany({ status: 'pending' }, { status:
'done' })`), esos documentos ya no harán match y no se propagarán
correctamente. Si esto te afecta, la alternativa es capturar los `_id`
afectados *antes* de actualizar — puedes hacerlo sobreescribiendo
`updateMany` en un `customService`.

## Licencia

MIT