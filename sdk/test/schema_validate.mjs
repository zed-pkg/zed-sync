// A tiny, dependency-free validator for the exact JSON Schema 2020-12 subset the
// protocol/*.schema.json files use: type (incl. arrays + "integer"), enum, oneOf,
// required, properties, additionalProperties:false, pattern, min/max,
// {min,max}Length, and array items/{min,max}Items, with local "#/$defs/..."
// $ref resolution. Kept deliberately
// small — the SDK ships no runtime deps — and self-checked by the suite that
// uses it (valid payloads pass, malformed ones are rejected). This is how one
// shared schema validates the I/O wire for every language port (goal #3).

/** @returns {string[]} list of error paths+reasons; empty means valid. */
export function validate(schema, value, root = schema, path = "$") {
  const errors = [];

  if (schema.$ref) {
    return validate(resolveRef(root, schema.$ref), value, root, path);
  }

  if (schema.oneOf) {
    const matchingBranches = schema.oneOf.filter(
      (branch) => validate(branch, value, root, path).length === 0,
    ).length;
    if (matchingBranches !== 1) {
      errors.push(`${path}: expected exactly one oneOf branch, matched ${matchingBranches}`);
      return errors;
    }
  }

  if (schema.type !== undefined && !matchesType(schema.type, value)) {
    errors.push(`${path}: expected type ${JSON.stringify(schema.type)}, got ${describe(value)}`);
    return errors; // type mismatch: downstream checks would be noise
  }

  if (schema.enum && !schema.enum.some((e) => e === value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }

  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: "${value}" does not match /${schema.pattern}/`);
    }
    if (schema.minLength != null && value.length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
    if (schema.maxLength != null && value.length > schema.maxLength) {
      errors.push(`${path}: longer than maxLength ${schema.maxLength}`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path}: above maximum ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) {
      errors.push(`${path}: shorter than minItems ${schema.minItems}`);
    }
    if (schema.maxItems != null && value.length > schema.maxItems) {
      errors.push(`${path}: longer than maxItems ${schema.maxItems}`);
    }
    if (schema.items) {
      for (const [index, item] of value.entries()) {
        errors.push(...validate(schema.items, item, root, `${path}[${index}]`));
      }
    }
  }

  if (isPlainObject(value) && (schema.properties || schema.required || schema.additionalProperties === false)) {
    for (const key of schema.required ?? []) {
      if (!(key in value) || value[key] === undefined) errors.push(`${path}: missing required "${key}"`);
    }
    for (const [key, v] of Object.entries(value)) {
      if (v === undefined) continue; // wire-absent
      const propSchema = schema.properties?.[key];
      if (propSchema) {
        errors.push(...validate(propSchema, v, root, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: unexpected property "${key}"`);
      }
    }
  }

  return errors;
}

/** True iff `value` is valid against `schema`. */
export const isValid = (schema, value) => validate(schema, value).length === 0;

function resolveRef(root, ref) {
  if (!ref.startsWith("#/")) throw new Error(`unsupported $ref ${ref}`);
  return ref
    .slice(2)
    .split("/")
    .reduce((acc, seg) => acc[seg], root);
}

function matchesType(type, value) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => matchesOne(t, value));
}

function matchesOne(t, value) {
  switch (t) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    default:
      throw new Error(`unsupported type ${t}`);
  }
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function describe(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
