// The Standard Schema interface (https://standardschema.dev), copied as its spec
// recommends, without the spec's namespace.

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => SchemaResult<Output> | Promise<SchemaResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
    /** Standard JSON Schema (https://standardschema.dev/json-schema), where the library has it. */
    readonly jsonSchema?: {
      readonly input: (options: { readonly target: string }) => JsonSchema;
      readonly output: (options: { readonly target: string }) => JsonSchema;
    };
  };
}

export type JsonSchema = Record<string, unknown>;

export type SchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<SchemaIssue> };

export interface SchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}

export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
  Schema['~standard']['types']
>['output'];
