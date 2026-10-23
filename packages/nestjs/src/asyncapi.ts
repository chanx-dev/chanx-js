import type { DynamicModule, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AsyncAPIDocument, AsyncAPIOptions } from '@chanx-js/server';

import { ChanxService } from './service';

/**
 * The AsyncAPI document of a Nest app's gateways, without serving it: boots the module as
 * an application context (no HTTP server), reads the document, and closes it. Providers
 * still start, so a database module connects as it would at startup.
 */
export async function asyncapiOf(
  module: Type | DynamicModule,
  options?: AsyncAPIOptions,
): Promise<AsyncAPIDocument> {
  const app = await NestFactory.createApplicationContext(module, { logger: false });
  try {
    return app.get(ChanxService).asyncapi(options);
  } finally {
    await app.close();
  }
}
