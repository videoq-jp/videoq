import { customType } from "drizzle-orm/sqlite-core";

/** Better Auth Date fields use canonical UTC text, preserving millisecond precision. */
export const isoDate = customType<{ data: Date; driverData: string }>({
  dataType: () => "text",
  toDriver: value => value.toISOString(),
  fromDriver: value => new Date(value),
});
