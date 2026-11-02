import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import configuration from './config/configuration';
import { HealthController } from './health.controller';
import { ParticleRecordsModule } from './particle-records/particle-records.module';
import { UiController } from './ui/ui.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ load: [configuration], isGlobal: true }),
    ScheduleModule.forRoot(),
    ParticleRecordsModule,
  ],
  controllers: [HealthController, UiController],
})
export class AppModule {}
