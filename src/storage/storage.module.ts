import { Module } from '@nestjs/common';
import { FileParticleStore } from './file-particle-store.service';
import { PARTICLE_STORE } from './particle-store';

/** POC storage. On merge, bind PARTICLE_STORE to a DatabaseService-backed implementation instead. */
@Module({
  providers: [{ provide: PARTICLE_STORE, useClass: FileParticleStore }],
  exports: [PARTICLE_STORE],
})
export class StorageModule {}
