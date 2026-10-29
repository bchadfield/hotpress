// A small schema builder with type inference. Fields coerce from the strings that CSV and
// frontmatter produce, and every problem is collected with its path so a build reports all
// errors at once.

export interface Issue {
  path: string;
  message: string;
}

export class SchemaError extends Error {
  readonly issues: Issue[];
  constructor(issues: Issue[]) {
    super(issues.map((i) => `${i.path}: ${i.message}`).join("\n"));
    this.issues = issues;
  }
}

const MISSING = Symbol("missing");

function describe(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value instanceof Date) return `date ${value.toISOString()}`;
  if (typeof value === "string") return `"${value.length > 60 ? value.slice(0, 57) + "…" : value}"`;
  return JSON.stringify(value) ?? String(value);
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

export abstract class Field<T> {
  /** @internal */ readonly _type!: T;
  protected isOptional = false;
  protected defaultValue: unknown = MISSING;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected checks: { test: (v: any) => boolean; message: string }[] = [];

  protected abstract coerce(value: unknown, path: string, issues: Issue[]): T | typeof MISSING;
  abstract readonly kind: string;

  parse(value: unknown, path: string, issues: Issue[]): T {
    if (isEmpty(value)) {
      if (this.defaultValue !== MISSING) {
        return (typeof this.defaultValue === "function" ? (this.defaultValue as () => T)() : this.defaultValue) as T;
      }
      if (this.isOptional) return undefined as T;
      issues.push({ path, message: `required ${this.kind} is missing` });
      return undefined as T;
    }
    const result = this.coerce(value, path, issues);
    if (result === MISSING) return undefined as T;
    for (const check of this.checks) {
      if (!check.test(result)) issues.push({ path, message: check.message.replace("{value}", describe(result)) });
    }
    return result;
  }

  optional(): Field<T | undefined> {
    const copy = this.clone();
    copy.isOptional = true;
    return copy as Field<T | undefined>;
  }

  default(value: T | (() => T)): Field<T> {
    const copy = this.clone();
    copy.defaultValue = value;
    return copy;
  }

  refine(test: (value: T) => boolean, message: string): this {
    const copy = this.clone();
    copy.checks = [...this.checks, { test, message }];
    return copy;
  }

  protected clone(): this {
    return Object.assign(Object.create(Object.getPrototypeOf(this)), this);
  }

  protected fail(issues: Issue[], path: string, value: unknown): typeof MISSING {
    issues.push({ path, message: `expected ${this.kind}, got ${describe(value)}` });
    return MISSING;
  }
}

class StringField extends Field<string> {
  readonly kind: string = "string";
  protected coerce(value: unknown, path: string, issues: Issue[]) {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return this.fail(issues, path, value);
  }
  min(length: number): this {
    return this.refine((v) => v.length >= length, `must be at least ${length} characters, got {value}`);
  }
  max(length: number): this {
    return this.refine((v) => v.length <= length, `must be at most ${length} characters, got {value}`);
  }
  pattern(re: RegExp, message?: string): this {
    return this.refine((v) => re.test(v), message ?? `must match ${re}, got {value}`);
  }
}

class SlugField extends StringField {
  override readonly kind = "slug";
  protected override coerce(value: unknown, path: string, issues: Issue[]) {
    const s = super.coerce(value, path, issues);
    if (s === MISSING) return s;
    const trimmed = (s as string).trim();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed)) {
      issues.push({ path, message: `expected a slug (lowercase letters, digits and single hyphens), got ${describe(s)}` });
      return MISSING;
    }
    return trimmed;
  }
}

class NumberField extends Field<number> {
  readonly kind = "number";
  protected coerce(value: unknown, path: string, issues: Issue[]) {
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
    if (!Number.isFinite(n)) return this.fail(issues, path, value);
    return n;
  }
  min(min: number): this {
    return this.refine((v) => v >= min, `must be >= ${min}, got {value}`);
  }
  max(max: number): this {
    return this.refine((v) => v <= max, `must be <= ${max}, got {value}`);
  }
  int(): this {
    return this.refine((v) => Number.isInteger(v), "must be a whole number, got {value}");
  }
}

class BooleanField extends Field<boolean> {
  readonly kind = "boolean";
  protected coerce(value: unknown, path: string, issues: Issue[]) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const v = value.trim().toLowerCase();
      if (["true", "yes", "1"].includes(v)) return true;
      if (["false", "no", "0"].includes(v)) return false;
    }
    return this.fail(issues, path, value);
  }
}

class DateField extends Field<Date> {
  readonly kind = "date";
  protected coerce(value: unknown, path: string, issues: Issue[]) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    if (typeof value === "string") {
      const v = value.trim();
      // Only ISO 8601 forms: "2024-01-31", "2024-01-31T10:00:00Z", with offsets. Bare dates are UTC.
      if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(v)) {
        const d = new Date(v.length === 10 ? `${v}T00:00:00Z` : v.replace(" ", "T"));
        if (!Number.isNaN(d.getTime()) && (v.length !== 10 || d.toISOString().slice(0, 10) === v)) return d;
      }
    }
    return this.fail(issues, path, value);
  }
}

class EnumField<T extends string> extends Field<T> {
  readonly kind: string;
  private values: readonly T[];
  constructor(values: readonly T[]) {
    super();
    this.values = values;
    this.kind = `one of ${values.map((v) => `"${v}"`).join(", ")}`;
  }
  protected coerce(value: unknown, path: string, issues: Issue[]) {
    if (typeof value === "string" && (this.values as readonly string[]).includes(value)) return value as T;
    return this.fail(issues, path, value);
  }
}

class ArrayField<T> extends Field<T[]> {
  readonly kind: string;
  private item: Field<T>;
  private separator?: string;
  constructor(item: Field<T>, separator?: string) {
    super();
    this.item = item;
    this.separator = separator;
    this.kind = `list of ${item.kind}`;
  }
  /** Accept a delimited string too, for CSV columns ("a|b|c"). */
  split(separator: string): ArrayField<T> {
    return new ArrayField(this.item, separator);
  }
  protected coerce(value: unknown, path: string, issues: Issue[]) {
    let list = value;
    if (typeof value === "string" && this.separator !== undefined) list = value.split(this.separator).map((v) => v.trim()).filter(Boolean);
    if (!Array.isArray(list)) return this.fail(issues, path, value);
    return list.map((v, i) => this.item.parse(v, `${path}[${i}]`, issues));
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Shape = Record<string, Field<any>>;
export type Infer<S extends Shape> = { [K in keyof S]: S[K]["_type"] };

class ObjectField<S extends Shape> extends Field<Infer<S>> {
  readonly kind = "object";
  readonly shape: S;
  private strictKeys = false;
  constructor(shape: S) {
    super();
    this.shape = shape;
  }
  /** Reject keys that aren't in the shape (catches typos in frontmatter). */
  strict(): this {
    const copy = this.clone();
    copy.strictKeys = true;
    return copy;
  }
  protected coerce(value: unknown, path: string, issues: Issue[]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return this.fail(issues, path, value);
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input)) {
      if (!(key in this.shape)) {
        if (this.strictKeys) issues.push({ path: join(path, key), message: "unknown field" });
        else out[key] = input[key];
      }
    }
    for (const [key, field] of Object.entries(this.shape)) out[key] = field.parse(input[key], join(path, key), issues);
    return out as Infer<S>;
  }
}

class AnyField<T> extends Field<T> {
  readonly kind = "value";
  protected coerce(value: unknown) {
    return value as T;
  }
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

export const s = {
  string: () => new StringField(),
  slug: () => new SlugField(),
  number: () => new NumberField(),
  boolean: () => new BooleanField(),
  date: () => new DateField(),
  enum: <const T extends string>(values: readonly T[]) => new EnumField<T>(values),
  array: <T>(item: Field<T>) => new ArrayField<T>(item),
  object: <S extends Shape>(shape: S) => new ObjectField<S>(shape),
  any: <T = unknown>() => new AnyField<T>()
};

export type { ObjectField };

/** Validate a record against a shape; returns the parsed value and any issues. */
export function validate<S extends Shape>(shape: S | ObjectField<S>, value: unknown, path = ""): { value: Infer<S>; issues: Issue[] } {
  const field = shape instanceof ObjectField ? shape : new ObjectField(shape);
  const issues: Issue[] = [];
  const parsed = field.parse(value ?? {}, path, issues);
  return { value: parsed, issues };
}
