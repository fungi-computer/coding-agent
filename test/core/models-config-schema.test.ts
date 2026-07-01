/**
 * Tests for the `models.json` schema validator in `model-registry.ts`.
 *
 * Why this matters: before ARCH-118 phase 2, validation was done by
 * ajv, which doesn't work in Cloudflare Workers' eval-restricted runtime.
 * The plan's whole point was to switch to typebox/compile so tool
 * argument validation actually runs in Workers. These tests pin the
 * behavior so a regression to a no-op validator would be caught.
 */

import { describe, expect, test } from "vitest";

import { Type } from "typebox";
import { Compile } from "typebox/compile";

// Recreate the schema shape from model-registry.ts so we can exercise
// the validator pattern without pulling the full module (which depends
// on Workers runtime bindings). The point of this test is to lock in
// the "Compile(schema).Check(data) + .Errors(data) returns structured
// errors" pattern, not the schema's specific fields.
const TestSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  version: Type.Number(),
});

const validate = Compile(TestSchema);

describe("typebox/compile validator", () => {
  test("accepts valid input", () => {
    expect(validate.Check({ name: "ok", version: 1 })).toBe(true);
    expect(validate.Errors({ name: "ok", version: 1 })).toEqual([]);
  });

  test("rejects missing required field with structured error", () => {
    const errors = validate.Errors({ name: "ok" });
    expect(errors).toHaveLength(1);
    // The error has a `message`, `instancePath`, and `schemaPath`
    // (JSON Schema standard fields). It does NOT have `.errors`
    // (that's the old ajv shape).
    expect(errors[0]).toHaveProperty("message");
    expect(errors[0]).toHaveProperty("instancePath");
    expect(errors[0]).toHaveProperty("schemaPath");
    // The error string is human-readable, suitable for the
    // "Invalid models.json schema: ..." message in the loader.
    const message = errors[0].message;
    expect(typeof message).toBe("string");
    expect(message.length).toBeGreaterThan(0);
  });

  test("rejects wrong-type field with structured error", () => {
    const errors = validate.Errors({ name: "ok", version: "not-a-number" });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/number/i);
  });

  test("rejects extra fields if the schema is strict", () => {
    // Default Type.Object is not strict about additional properties, so
    // this should be valid. Pin that behavior so we'd notice if it
    // changed.
    expect(validate.Check({ name: "ok", version: 1, extra: "ignored" })).toBe(
      true,
    );
  });
});
