import { Type } from '@nestjs/common';

const SERVICE_SUFFIX = 'RepositoryService';

/** Ej: getRepositoryToken(Position) -> "PositionRepositoryService" */
export function getRepositoryToken<T>(entity: Type<T>): string {
    return `${entity.name}${SERVICE_SUFFIX}`;
}

export function getBackupSyncToken<T>(entity: Type<T>): string {
    return `${entity.name}BackupSyncService`;
}

export function getTombstoneModelName<T>(entity: Type<T>): string {
    return `${entity.name}Tombstone`;
}

export function getSyncCheckpointModelName<T>(entity: Type<T>): string {
    return `${entity.name}SyncCheckpoint`;
}