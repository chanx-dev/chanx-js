import 'reflect-metadata';

import { ApiProperty } from '@nestjs/swagger';
import type { AsyncAPIDocument } from '@chanx-js/server';
import { consumer, createChanx, defineMessage } from '@chanx-js/server';
import { connect } from '@chanx-js/server/testing';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  IsNumber,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { describe, expect, it } from 'vitest';

import { dtoSchema } from '../src';

class Geo {
  @ApiProperty()
  @IsNumber()
  lat!: number;
}

class Address {
  @ApiProperty({ description: 'Street and number' })
  @IsString()
  street!: string;

  @ApiProperty({ type: Geo })
  @ValidateNested()
  @Type(() => Geo)
  geo!: Geo;
}

// Documented by @ApiProperty, so AsyncAPI takes @nestjs/swagger's schema.
class Signup {
  @ApiProperty({ format: 'email' })
  @IsEmail()
  email!: string;

  @ApiProperty({ minimum: 18 })
  @IsInt()
  @Min(18)
  age!: number;

  @ApiProperty({ type: Address })
  @ValidateNested()
  @Type(() => Address)
  address!: Address;
}

// Only validation decorators, so AsyncAPI takes class-validator-jsonschema's schema.
class Rename {
  @IsString()
  @MinLength(2)
  name!: string;
}

const signup = dtoSchema(Signup)['~standard'];
const valid = {
  email: 'ann@example.com',
  age: 30,
  address: { street: '1 Main St', geo: { lat: 1.5 } },
};

describe('dtoSchema', () => {
  it('validates into an instance of the DTO, nested ones included', async () => {
    const result = await signup.validate(valid);

    expect(result.issues).toBeUndefined();
    const value = (result as { value: Signup }).value;
    expect(value).toBeInstanceOf(Signup);
    expect(value.address).toBeInstanceOf(Address);
  });

  it('reports each failed constraint at its path, into nested DTOs', async () => {
    const result = await signup.validate({
      ...valid,
      age: 12,
      address: { street: 5, geo: { lat: 'north' } },
    });

    expect(result.issues).toEqual([
      { message: 'age must not be less than 18', path: ['age'] },
      { message: 'street must be a string', path: ['address', 'street'] },
      {
        message: 'lat must be a number conforming to the specified constraints',
        path: ['address', 'geo', 'lat'],
      },
    ]);
  });

  it('refuses a payload that is not an object', async () => {
    expect((await signup.validate([valid])).issues).toEqual([
      { message: 'Input should be a valid dictionary', path: [] },
    ]);
  });

  it("answers a client's invalid payload in chanx's error shape", async () => {
    const Rename_ = defineMessage('rename', dtoSchema(Rename));
    const app = createChanx({
      consumers: [consumer('/ws', { name: 'profile' }).on(Rename_, () => {})],
    });
    const client = connect(app, '/ws');

    expect(
      await client.request({ action: 'rename', payload: { name: 'x' } }),
    ).toMatchObject({
      action: 'error',
      payload: [
        {
          type: 'value_error',
          loc: ['rename', 'payload', 'name'],
          msg: 'name must be longer than or equal to 2 characters',
        },
      ],
    });
  });
});

describe('dtoSchema in AsyncAPI', () => {
  const document = createChanx({
    consumers: [
      consumer('/ws', { name: 'profile' })
        .on(defineMessage('signup', dtoSchema(Signup)), () => {})
        .on(defineMessage('rename', dtoSchema(Rename)), () => {}),
    ],
  }).asyncapi() as AsyncAPIDocument;
  const { schemas } = document.components;

  it('documents a DTO with @ApiProperty from @nestjs/swagger, its nested DTOs as components', () => {
    expect(schemas.SignupMessage).toMatchObject({
      properties: { payload: { $ref: '#/components/schemas/Signup' } },
    });
    expect(schemas.Signup).toMatchObject({
      title: 'Signup',
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email' },
        age: { type: 'number', minimum: 18 },
        address: { $ref: '#/components/schemas/Address' },
      },
    });
    expect(schemas.Address).toMatchObject({
      title: 'Address',
      properties: {
        street: { type: 'string', description: 'Street and number' },
        geo: { $ref: '#/components/schemas/Geo' },
      },
    });
    expect(schemas.Geo).toMatchObject({
      title: 'Geo',
      properties: { lat: { type: 'number' } },
    });
  });

  it('documents a DTO with only validation decorators from class-validator-jsonschema', () => {
    expect(schemas.Rename).toMatchObject({
      title: 'Rename',
      type: 'object',
      properties: { name: { type: 'string', minLength: 2 } },
      required: ['name'],
    });
  });
});
