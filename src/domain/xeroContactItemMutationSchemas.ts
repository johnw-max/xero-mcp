import { z } from "zod/v4";

const compactText = (maximum: number) => z.string().trim().min(1).max(maximum)
  .transform((value) => value.replace(/\s+/gu, " "));

const sourceFields = {
  source_ref: z.string().trim().min(1).max(512)
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "must not contain control characters")
    .refine((value) => !/^https?:\/\//iu.test(value), "must be an opaque reference, not a URL")
    .refine((value) => !value.includes("?") && !value.includes("#"), "must not contain query or fragment data"),
  source_unit_key: z.string().trim().min(1).max(256)
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "must not contain control characters"),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
} as const;

const phone = z.object({
  phone_type: z.enum(["DEFAULT", "DDI", "MOBILE", "FAX", "OFFICE"]),
  phone_number: compactText(50),
  area_code: compactText(10).optional(),
  country_code: compactText(20).optional(),
}).strict();

const address = z.object({
  address_type: z.enum(["POBOX", "STREET"]),
  line_1: compactText(500).optional(),
  line_2: compactText(500).optional(),
  line_3: compactText(500).optional(),
  line_4: compactText(500).optional(),
  city: compactText(255).optional(),
  region: compactText(255).optional(),
  postal_code: compactText(50).optional(),
  country: compactText(50).optional(),
  attention_to: compactText(255).optional(),
}).strict().refine((value) => Object.keys(value).some((key) => key !== "address_type"), {
  message: "an address must contain at least one address field",
});

const contactBasicFields = {
  name: compactText(255).optional(),
  first_name: compactText(255).optional(),
  last_name: compactText(255).optional(),
  email: z.string().trim().email().max(255).transform((value) => value.toLowerCase()).optional(),
  company_number: compactText(50).optional(),
  account_number: compactText(50).optional(),
  phones: z.array(phone).min(1).max(5)
    .refine((values) => new Set(values.map((value) => value.phone_type)).size === values.length,
      "phones must not repeat a phone_type").optional(),
  addresses: z.array(address).min(1).max(2)
    .refine((values) => new Set(values.map((value) => value.address_type)).size === values.length,
      "addresses must not repeat an address_type").optional(),
} as const;

export const prepareContactCreateMutationSchema = z.object({
  ...sourceFields,
  ...contactBasicFields,
  name: compactText(255),
}).strict();

export const prepareContactUpdateMutationSchema = z.object({
  ...sourceFields,
  contact_id: z.string().uuid(),
  patch: z.object(contactBasicFields).strict().refine((value) => Object.keys(value).length > 0, {
    message: "contact patch must include at least one basic field",
  }),
}).strict();

const itemBasicCreateFields = {
  code: compactText(30),
  name: compactText(50).optional(),
  description: compactText(4_000).optional(),
  purchase_description: compactText(4_000).optional(),
  is_sold: z.boolean().default(true),
  is_purchased: z.boolean().default(true),
} as const;

const itemBasicPatch = z.object({
  name: compactText(50).optional(),
  description: compactText(4_000).optional(),
  purchase_description: compactText(4_000).optional(),
  is_sold: z.boolean().optional(),
  is_purchased: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "item patch must include at least one basic field",
});

export const prepareItemCreateMutationSchema = z.object({
  ...sourceFields,
  ...itemBasicCreateFields,
}).strict().superRefine((value, context) => {
  if (!value.is_sold && value.description) {
    context.addIssue({ code: "custom", path: ["description"], message: "description requires is_sold=true" });
  }
  if (!value.is_purchased && value.purchase_description) {
    context.addIssue({
      code: "custom",
      path: ["purchase_description"],
      message: "purchase_description requires is_purchased=true",
    });
  }
  if (!value.is_sold && !value.is_purchased) {
    context.addIssue({ code: "custom", path: ["is_sold"], message: "item must remain usable" });
  }
});

export const prepareItemUpdateMutationSchema = z.object({
  ...sourceFields,
  item_id: z.string().uuid(),
  patch: itemBasicPatch,
}).strict();

export type PrepareContactCreateMutationInput = z.infer<typeof prepareContactCreateMutationSchema>;
export type PrepareContactUpdateMutationInput = z.infer<typeof prepareContactUpdateMutationSchema>;
export type PrepareItemCreateMutationInput = z.infer<typeof prepareItemCreateMutationSchema>;
export type PrepareItemUpdateMutationInput = z.infer<typeof prepareItemUpdateMutationSchema>;
