import { requestBodyText } from "./helpers/request-body";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { billingRoutes } from "../src/features/billing/routes";
import { createApp } from "../src/app";

const constructEventAsync = vi.fn();
const checkoutCreate = vi.fn();
const portalCreate = vi.fn();
const pricesList = vi.fn();
const customersCreate = vi.fn();
const subscriptionsRetrieve = vi.fn();

vi.mock("stripe", () => {
  class Stripe {
    static createFetchHttpClient() {
      return {};
    }
    webhooks = { constructEventAsync };
    checkout = { sessions: { create: checkoutCreate } };
    billingPortal = { sessions: { create: portalCreate } };
    prices = { list: pricesList };
    customers = { create: customersCreate };
    subscriptions = { retrieve: subscriptionsRetrieve };
    constructor() {}
  }
  return { default: Stripe };
});

import {
  executeFakePgQuery,
  type PgQueryInput,
  type QueryCall,
  type MatchableSql,
} from "./helpers/pg-fake";

const calls: QueryCall[] = [];
let rowsFor: (sql: MatchableSql, args: unknown[]) => Record<string, unknown>[];

vi.mock("pg", () => {
  class FakeClient {
    async connect() {}
    async end() {}
    async query(sqlOrConfig: unknown, args: unknown[] = []) {
      return executeFakePgQuery({
        calls,
        sqlOrConfig: sqlOrConfig as PgQueryInput,
        args,
        rowsFor,
      });
    }
  }
  return { default: { Client: FakeClient } };
});

const SECRET = "test-jwt-secret-billing";
const ENV = {
  ENVIRONMENT: "development",
  AUTH_JWT_SECRET: SECRET,
  BETTER_AUTH_SECRET: SECRET,
  FRONTEND_URL: "http://localhost",
  STRIPE_SECRET_KEY: "rk_test_billing",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
  STRIPE_AUTOMATIC_TAX: "false",
  HYPERDRIVE: { connectionString: "postgres://fake/db" },
} as unknown as Record<string, unknown>;

beforeEach(() => {
  calls.length = 0;
  constructEventAsync.mockReset();
  checkoutCreate.mockReset();
  portalCreate.mockReset();
  pricesList.mockReset().mockResolvedValue({ data: [
    ["basic_monthly", 1480, 999], ["basic_yearly", 14800, 9990],
    ["pro_monthly", 3980, 2699], ["pro_yearly", 39800, 26990],
  ].map(([key, yen, cents]) => ({
    id: `price_${key}`, lookup_key: key, active: true, type: "recurring", billing_scheme: "per_unit",
    recurring: { interval: String(key).endsWith("yearly") ? "year" : "month", interval_count: 1 },
    currency: "jpy", unit_amount: yen, currency_options: { usd: { unit_amount: cents } },
  })) });
  customersCreate.mockReset();
  subscriptionsRetrieve.mockReset();
  rowsFor = () => [];
});

const req = (path: string, init: RequestInit = {}) => {
  if (path === "/plans") {
    return createApp().request("/api/trpc/billing.plans", init, ENV);
  }
  if (path === "/checkout") {
    const body = JSON.parse(requestBodyText(init.body ?? "{}")) as { lookup_key?: string };
    return createApp().request(
      "/api/trpc/billing.checkout",
      { ...init, body: JSON.stringify({ lookupKey: body.lookup_key }) },
      ENV,
    );
  }
  return billingRoutes.request(path, init, ENV);
};

describe("billing API", () => {
  it("GET /plans はカタログを返す", async () => {
    const res = await req("/plans");
    expect(res.status).toBe(200);
    const body = (await res.json<{
      result: { data: { code: string; amount_yen: number }[] };
    }>());
    expect(body.result.data.some((p) => p.code === "free" && p.amount_yen === 0)).toBe(true);
    expect(body.result.data.some((p) => p.code === "basic" && p.amount_yen === 1480)).toBe(true);
    expect(body.result.data.some((p) => p.code === "pro" && p.amount_yen === 3980)).toBe(true);
  });

  it("未ログインの checkout は 401", async () => {
    const res = await req("/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lookup_key: "basic_monthly" }),
    });
    expect(res.status).toBe(401);
  });

  it("English catalog returns USD cents from Stripe for monthly and annual prices", async () => {
    const input = encodeURIComponent(JSON.stringify({ locale: "en" }));
    const res = await createApp().request(`/api/trpc/billing.plans?input=${input}`, {}, ENV);
    expect(res.status).toBe(200);
    const body = await res.json<{ result: { data: { code: string; interval: string; currency: string; unit_amount: number; amount_yen?: number }[] } }>();
    expect(body.result.data.map(p => [p.code, p.interval, p.currency, p.unit_amount])).toEqual([
      ["free", null, "usd", 0], ["basic", "month", "usd", 999],
      ["basic", "year", "usd", 9990], ["pro", "month", "usd", 2699], ["pro", "year", "usd", 26990],
    ]);
    expect(body.result.data.every(p => p.amount_yen === undefined)).toBe(true);
    expect(pricesList).toHaveBeenCalledWith(expect.objectContaining({ expand: ["data.currency_options"] }));
  });

  it.each([
    { currency_options: {} },
    { currency_options: { usd: { unit_amount: null } } },
    { currency_options: { usd: { unit_amount: 0 } } },
    { recurring: { interval: "year", interval_count: 1 } },
  ])("does not advertise an unavailable or incorrectly configured USD price: %j", async badPrice => {
    const configured = await pricesList();
    configured.data[0] = { ...configured.data[0], ...badPrice };
    pricesList.mockResolvedValue(configured);
    const input = encodeURIComponent(JSON.stringify({ locale: "en" }));
    const res = await createApp().request(`/api/trpc/billing.plans?input=${input}`, {}, ENV);
    expect(res.status).toBe(500); // The tRPC transport maps service-unavailable errors to 500.
    expect(await res.json()).toHaveProperty("error");
  });

  it("webhook は署名ヘッダなしで 400", async () => {
    const res = await req("/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  it.each([false, true])("preserves webhook bytes at the body limit (Content-Length: %s)", async withLength => {
    const rawBody = '{ "id": "evt_1", "description": "日本語" }\n'.padEnd(4 * 1024 * 1024 - 6);
    const bytes = new TextEncoder().encode(rawBody);
    expect(bytes.byteLength).toBe(4 * 1024 * 1024);
    constructEventAsync.mockResolvedValue({ id: "evt_1", type: "invoice.paid" });
    rowsFor = sql => sql.includes("stripe_events") ? [{ id: "evt_1" }] : [];
    const headers: Record<string, string> = {
      "content-type": "application/json", "stripe-signature": "t=1,v1=abc",
    };
    if (withLength) headers["content-length"] = String(bytes.byteLength);
    const res = await createApp().request("/api/billing/webhook", {
      method: "POST", headers, body: bytes,
    }, ENV);
    expect(res.status).toBe(200);
    expect(constructEventAsync).toHaveBeenCalledWith(rawBody, "t=1,v1=abc", ENV.STRIPE_WEBHOOK_SECRET);
  });

  it("重複 event は再処理しない", async () => {
    constructEventAsync.mockResolvedValue({
      id: "evt_1",
      type: "invoice.paid",
      data: { object: { customer: "cus_1", parent: { subscription_details: { subscription: "sub_1" } } } },
    });
    rowsFor = (sql) => {
      if (sql.includes("SELECT") && sql.includes("stripe_events")) return [{ id: "evt_1" }];
      return [];
    };
    const res = await req("/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=1,v1=abc",
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(subscriptionsRetrieve).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });
});
