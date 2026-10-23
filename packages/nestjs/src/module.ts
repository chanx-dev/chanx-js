import { Module, type DynamicModule } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import { ChanxExplorer } from './explorer';
import type { ChanxModuleOptions } from './options';
import { ConfigurableModuleClass } from './options';
import { ChanxService } from './service';

/**
 * Serves every `@ChanxConsumer` provider on the app's HTTP server. Import once, at the
 * root: `forRoot(options)`, or `forRootAsync({ useFactory, inject })` for options from
 * other providers.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [ChanxService, ChanxExplorer],
  exports: [ChanxService],
})
export class ChanxModule extends ConfigurableModuleClass {
  static override forRoot(options: ChanxModuleOptions = {}): DynamicModule {
    return super.forRoot(options);
  }
}
