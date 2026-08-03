const schema = (kind: string, options?: unknown) => ({ kind, options });

export const Type = {
  Object: (properties: unknown) => ({ kind: "object", properties }),
  Optional: (value: unknown) => ({ kind: "optional", value }),
  String: (options?: unknown) => schema("string", options),
  Boolean: (options?: unknown) => schema("boolean", options),
};
