import { ConfigurableModuleBuilder } from '@nestjs/common';
import type { ConfigurableModuleAsyncOptions } from '@nestjs/common';
import type { AsyncAPIServeOptions, ChanxOptions } from '@chanx-js/server';

/** Options for `ChanxModule.forRoot()`: `createChanx`'s, less the consumers it finds itself. */
export interface ChanxModuleOptions extends Omit<ChanxOptions, 'consumers'> {
  /** Passed to `attachChanx`: how often idle clients are pinged. */
  pingInterval?: number;
  /** Serve the AsyncAPI docs page and document on the app's HTTP server, at `/asyncapi` unless `path` says otherwise. */
  asyncapi?: boolean | AsyncAPIServeOptions;
}

export const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN: CHANX_OPTIONS } =
  new ConfigurableModuleBuilder<ChanxModuleOptions>()
    .setClassMethodName('forRoot')
    .setExtras({}, (definition) => ({ ...definition, global: true }))
    .build();

/** Options for `ChanxModule.forRootAsync()`: a factory, class or existing provider. */
export type ChanxModuleAsyncOptions = ConfigurableModuleAsyncOptions<ChanxModuleOptions>;
