import { createRequire } from 'node:module';

import type { Type } from '@nestjs/common';
import type { JsonSchema, StandardSchemaV1 } from '@chanx-js/server';
import type * as ClassTransformerModule from 'class-transformer';
import type * as ClassValidatorModule from 'class-validator';
import type { ValidationError, ValidatorOptions } from 'class-validator';
import type * as ClassValidatorJsonSchemaModule from 'class-validator-jsonschema';
import type * as SwaggerModule from '@nestjs/swagger';

// Synchronous, as Standard JSON Schema's input() is, and optional: Nest loads
// class-validator for its ValidationPipe the same way.
const require = createRequire(import.meta.url);

function optional<T>(name: string): T | undefined {
  try {
    return require(name) as T;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') return undefined;
    throw error;
  }
}

/**
 * A class-validator DTO as a Standard Schema, for `defineMessage`: payloads are turned
 * into DTO instances and validated. AsyncAPI documents it from `@ApiProperty` when the DTO
 * has it (`@nestjs/swagger`), else from its validation decorators
 * (`class-validator-jsonschema`), else as an open object.
 *
 * ```ts
 * const Chat = defineMessage('chat', dtoSchema(ChatPayload));
 * ```
 */
export function dtoSchema<T extends object>(
  dto: Type<T>,
  validatorOptions: ValidatorOptions = {},
): StandardSchemaV1<unknown, T> {
  const { plainToInstance } =
    require('class-transformer') as typeof ClassTransformerModule;
  const { validate } = require('class-validator') as typeof ClassValidatorModule;
  const jsonSchema = jsonSchemaOf(dto);

  return {
    '~standard': {
      version: 1,
      vendor: 'class-validator',
      async validate(value) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          return {
            issues: [{ message: 'Input should be a valid dictionary', path: [] }],
          };
        }
        const instance = plainToInstance(dto, value);
        const errors = await validate(instance, validatorOptions);
        return errors.length
          ? { issues: errors.flatMap((error) => issuesOf(error, [])) }
          : { value: instance };
      },
      ...(jsonSchema && { jsonSchema: { input: jsonSchema, output: jsonSchema } }),
    },
  };
}

function issuesOf(
  error: ValidationError,
  parent: PropertyKey[],
): { message: string; path: PropertyKey[] }[] {
  const path = [
    ...parent,
    /^\d+$/.test(error.property) ? Number(error.property) : error.property,
  ];
  return [
    ...Object.values(error.constraints ?? {}).map((message) => ({ message, path })),
    ...(error.children ?? []).flatMap((child) => issuesOf(child, path)),
  ];
}

function jsonSchemaOf(dto: Type): (() => JsonSchema) | undefined {
  const swagger = optional<typeof SwaggerModule>('@nestjs/swagger');
  if (
    swagger &&
    Reflect.hasMetadata(swagger.DECORATORS.API_MODEL_PROPERTIES_ARRAY, dto.prototype)
  ) {
    return () => {
      const { schema, schemas } = swagger.generateSchema(dto);
      return withDefs(
        dto.name,
        schema as JsonSchema,
        schemas as Record<string, JsonSchema>,
        '#/components/schemas/',
      );
    };
  }
  const generator = optional<typeof ClassValidatorJsonSchemaModule>(
    'class-validator-jsonschema',
  );
  if (generator) {
    return () => {
      const schemas = generator.validationMetadatasToSchemas() as Record<
        string,
        JsonSchema
      >;
      return withDefs(
        dto.name,
        schemas[dto.name] ?? { type: 'object' },
        schemas,
        '#/definitions/',
      );
    };
  }
  return undefined;
}

// The DTO titled by its class name, as pydantic titles a model, with the schemas it
// references, transitively, as $defs: the AsyncAPI generator hoists both into components.
function withDefs(
  name: string,
  root: JsonSchema,
  schemas: Record<string, JsonSchema>,
  refPrefix: string,
): JsonSchema {
  const toDefs = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(toDefs);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === '$ref' && typeof item === 'string' && item.startsWith(refPrefix)
          ? `#/$defs/${item.slice(refPrefix.length)}`
          : toDefs(item),
      ]),
    );
  };
  const defs: Record<string, JsonSchema> = {};
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(collect);
    if (value === null || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref' && typeof item === 'string' && item.startsWith('#/$defs/')) {
        const ref = item.slice('#/$defs/'.length);
        if (ref !== name && !(ref in defs) && schemas[ref]) {
          defs[ref] = { title: ref, ...(toDefs(schemas[ref]) as JsonSchema) };
          collect(defs[ref]);
        }
      } else collect(item);
    }
  };
  const converted = { title: name, ...(toDefs(root) as JsonSchema) };
  collect(converted);
  return Object.keys(defs).length ? { ...converted, $defs: defs } : converted;
}
