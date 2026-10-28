import { Module } from '@nestjs/common';
import { PublicSiteController, WebsiteAdminController } from './website.controller';
import { WebsiteService } from './website.service';

@Module({ controllers: [PublicSiteController, WebsiteAdminController], providers: [WebsiteService] })
export class WebsiteModule {}
