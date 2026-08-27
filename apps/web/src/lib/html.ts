/** Tagged template that escapes interpolations by default. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((out, str, i) => {
    if (i === 0) return str;
    const v = values[i - 1];
    return out + (v instanceof Raw ? v.value : escape(String(v ?? ""))) + str;
  }, "");
}

class Raw {
  constructor(readonly value: string) {}
}

/** Opt out of escaping for trusted markup we generated ourselves. */
export function raw(value: string): Raw {
  return new Raw(value);
}

export function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
