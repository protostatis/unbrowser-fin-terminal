/**
 * vendored from @earendil-works/pi-ai@0.83.0 (MIT), stage 2a.
 *
 * `StringEnum` lives in pi-ai's dist/utils/typebox-helpers.js. Its actual
 * implementation is a TypeBox `Type.Unsafe` schema that emits a JSON-schema
 * `string` with an `enum` list — NOT a Type.Union of Type.Literal. It exists
 * because Google-style providers don't support anyOf/const patterns. The
 * extension calls both forms:
 *
 *   StringEnum(["day", "week", "month", "year", "max"] as const)
 *   StringEnum([...] as const, { description: "Chart scope; defaults to day" })
 *
 * The port below is byte-identical in behavior and keeps the exact pi-ai
 * signature (values + optional {description, default}).
 */

import { type TUnsafe, Type } from "typebox";

/**
 * Creates a string enum schema compatible with Google's API and other providers
 * that don't support anyOf/const patterns.
 *
 * @example
 * const OperationSchema = StringEnum(["add", "subtract", "multiply", "divide"], {
 *   description: "The operation to perform"
 * });
 *
 * type Operation = Static<typeof OperationSchema>; // "add" | "subtract" | "multiply" | "divide"
 */
export function StringEnum<T extends readonly string[]>(
	values: T,
	options?: {
		description?: string;
		default?: T[number];
	},
): TUnsafe<T[number]> {
	return Type.Unsafe({
		type: "string",
		enum: values,
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}
