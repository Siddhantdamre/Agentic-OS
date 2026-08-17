/**
 * NodeNext + @types/node types Response.json() as unknown.
 * Tool executors read untyped provider JSON. Keep that as any.
 * Included via tsconfig include of src. Not imported by application code.
 */
interface Body {
  json(): Promise<any>;
}
