import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GuardiansController, StudentGuardiansController } from './guardians.controller';
import { GuardiansService } from './guardians.service';

@Module({
  imports: [AuthModule],
  controllers: [GuardiansController, StudentGuardiansController],
  providers: [GuardiansService],
})
export class GuardiansModule {}
