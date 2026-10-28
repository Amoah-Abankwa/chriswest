import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { TenancyController } from './tenancy.controller';
import { TenantResolverMiddleware } from './tenant-resolver.middleware';

@Module({ controllers: [TenancyController] })
export class TenancyModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(TenantResolverMiddleware)
      .exclude({ path: 'health/*path', method: RequestMethod.ALL })
      .forRoutes('*path');
  }
}
