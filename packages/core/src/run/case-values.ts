/** A case's values: `id` and `title` from the start, and what its steps save afterwards. */
export class CaseValues extends Map<string, string> {
  readonly #saved = new Set<string>();

  constructor(id: string, title: string) {
    // the Map constructor would call set before the private field exists
    super();
    super.set("id", id);
    super.set("title", title);
  }

  override set(name: string, value: string): this {
    this.#saved.add(name);
    return super.set(name, value);
  }

  /** The current value of each name set after the constructor, in the order the names were first set. */
  saved(): Record<string, string> {
    return Object.fromEntries([...this.#saved].map((name) => [name, this.get(name) ?? ""]));
  }
}
