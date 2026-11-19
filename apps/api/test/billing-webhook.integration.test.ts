import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { billingRoutes } from "../src/features/billing/routes";
import { createCheckoutSession } from "../src/integrations/billing";
import { deleteAccountBilling } from "../src/features/billing/account-deletion";
import { PLAN_CATALOG } from "../src/features/billing/catalog";
import type { Bindings } from "../src/types/bindings";

const { constructEventAsync, subscriptionsRetrieve, customersCreate, customersDelete, checkoutCreate } = vi.hoisted(() => ({
  constructEventAsync: vi.fn(), subscriptionsRetrieve: vi.fn(), customersCreate: vi.fn(), customersDelete: vi.fn(), checkoutCreate: vi.fn(),
}));
vi.mock("stripe", () => ({
  default: class {
    static createFetchHttpClient() { return {}; }
    webhooks = { constructEventAsync };
    subscriptions = { retrieve: subscriptionsRetrieve };
    customers = { create: customersCreate, del: customersDelete };
    prices = { list: async () => ({ data: [{
      id: "price_basic", lookup_key: "basic_monthly", active: true, type: "recurring",
      billing_scheme: "per_unit", recurring: { interval: "month", interval_count: 1 },
      currency: "jpy", unit_amount: 1480, currency_options: { usd: { unit_amount: 999 } },
    }] }) };
    checkout = { sessions: { create: checkoutCreate } };
  },
}));

const databaseUrl = process.env.QUOTA_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("billing webhook on PostgreSQL", () => {
  const schema = `billing_${crypto.randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client;
  let env: Bindings;

  function subscription(status = "active", lookupKey = "pro_monthly") {
    return { id: "sub_1", customer: "cus_1", created: 100, status, metadata: { userId: "user_1" },
      items: { data: [{ price: { lookup_key: lookupKey } }] } };
  }
  function invoice() {
    return { customer: "cus_1", metadata: {},
      parent: { subscription_details: { subscription: "sub_1" } } };
  }
  function event(type = "invoice.paid", object: unknown = invoice()) {
    return { id: "evt_1", type, data: { object } };
  }
  function deliver() {
    return billingRoutes.request("/webhook", { method: "POST",
      headers: { "stripe-signature": "t=1,v1=test" }, body: "{ \"untouched\": true }" }, env);
  }
  async function state() {
    const user = (await admin.query("SELECT * FROM users WHERE id = 'user_1'")).rows[0];
    const events = (await admin.query("SELECT id, type FROM stripe_events ORDER BY id")).rows;
    const updates = (await admin.query("SELECT * FROM billing_updates")).rows;
    return { user, events, updates };
  }
  function limits(plan: "free" | "basic" | "pro") {
    const e = PLAN_CATALOG[plan].entitlements;
    return { max_video_upload_size_mb: e.maxVideoUploadSizeMb, storage_limit_gb: e.storageLimitGb, monthly_upload_limit_gb: e.monthlyUploadLimitGb,
      processing_limit_minutes: e.processingLimitMinutes, ai_answers_limit: e.aiAnswersLimit };
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`
      CREATE SCHEMA "${schema}";
      SET search_path TO "${schema}";
      CREATE TABLE users (
        monthly_upload_limit_gb double precision DEFAULT 2,
        id text PRIMARY KEY, email text DEFAULT 'user@example.test',
        banned boolean DEFAULT false, ban_expires timestamptz,
        stripe_customer_id text UNIQUE, stripe_subscription_id text UNIQUE,
        plan_code text NOT NULL DEFAULT 'free', subscription_status text,
        quota_source text NOT NULL DEFAULT 'plan', updated_at timestamptz NOT NULL DEFAULT now(),
        max_video_upload_size_mb integer DEFAULT 200, storage_limit_gb double precision DEFAULT 1,
        processing_limit_minutes integer DEFAULT 45, ai_answers_limit integer DEFAULT 30
      );
      CREATE TABLE stripe_events (id text PRIMARY KEY, type text NOT NULL, processed_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE billing_updates (user_id text NOT NULL);
      CREATE FUNCTION track_billing_update() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO billing_updates VALUES (NEW.id); RETURN NEW; END;
      $$;
      CREATE TRIGGER track_billing_update AFTER UPDATE ON users FOR EACH ROW EXECUTE FUNCTION track_billing_update();
    `);
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    url.searchParams.set("application_name", schema);
    env = { HYPERDRIVE: { connectionString: url.toString() }, STRIPE_SECRET_KEY: "sk_test_billing",
      STRIPE_WEBHOOK_SECRET: "whsec_test", ENVIRONMENT: "development" } as Bindings;
  });
  beforeEach(async () => {
    constructEventAsync.mockReset().mockResolvedValue(event());
    subscriptionsRetrieve.mockReset().mockResolvedValue(subscription());
    customersCreate.mockReset();
    customersDelete.mockReset().mockResolvedValue({ id: "cus_1", deleted: true });
    checkoutCreate.mockReset().mockResolvedValue({ url: "https://checkout.stripe.com/test" });
    await admin.query(`TRUNCATE users, stripe_events, billing_updates;
      INSERT INTO users (id, stripe_customer_id) VALUES ('user_1', 'cus_1'), ('user_2', 'cus_2')`);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await admin.end(); }
  });

  it.each(["jpy", "usd"])("verifies the untouched body and grants the same entitlements for %s", async currency => {
    subscriptionsRetrieve.mockResolvedValue({ ...subscription(), currency });
    expect((await deliver()).status).toBe(200);
    expect(constructEventAsync).toHaveBeenCalledExactlyOnceWith('{ "untouched": true }', "t=1,v1=test", "whsec_test");
    expect(await state()).toMatchObject({ user: { plan_code: "pro", subscription_status: "active",
      stripe_subscription_id: "sub_1", ...limits("pro") }, events: [{ id: "evt_1", type: "invoice.paid" }],
      updates: [{ user_id: "user_1" }] });
  });

  it("uses one persisted customer when initial checkout requests race", async () => {
    await admin.query("UPDATE users SET stripe_customer_id = NULL WHERE id = 'user_1'");
    let release!: () => void;
    const bothCreated = new Promise<void>(resolve => { release = resolve; });
    let created = 0;
    customersCreate.mockImplementation(async () => {
      const id = `cus_race_${++created}`;
      if (created === 2) release();
      await bothCreated;
      return { id };
    });
    const results = await Promise.all([
      createCheckoutSession(env, "user_1", "basic_monthly"),
      createCheckoutSession(env, "user_1", "basic_monthly"),
    ]);
    expect(results).toHaveLength(2);
    const customer = (await state()).user.stripe_customer_id;
    expect(customer).toMatch(/^cus_race_/);
    expect(checkoutCreate).toHaveBeenCalledTimes(2);
    for (const [params] of checkoutCreate.mock.calls) expect(params.customer).toBe(customer);
    expect((await state()).user.plan_code).toBe("free");
  });

  it.each([null, "2999-01-01T00:00:00Z"])("blocks checkout while an account is banned (expires=%s)", async expires => {
    await admin.query("UPDATE users SET banned = true, ban_expires = $1 WHERE id = 'user_1'", [expires]);
    await expect(createCheckoutSession(env, "user_1", "basic_monthly")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(customersCreate).not.toHaveBeenCalled();
    expect(checkoutCreate).not.toHaveBeenCalled();
  });

  it("allows checkout after a temporary ban expires", async () => {
    await admin.query("UPDATE users SET stripe_customer_id = NULL, banned = true, ban_expires = now() - interval '1 day' WHERE id = 'user_1'");
    customersCreate.mockResolvedValue({ id: "cus_expired_ban" });
    await expect(createCheckoutSession(env, "user_1", "basic_monthly")).resolves.toHaveProperty("url");
    expect(checkoutCreate).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_expired_ban" }));
  });

  it("does not start a subscription if deletion bans the user during customer creation", async () => {
    await admin.query("UPDATE users SET stripe_customer_id = NULL WHERE id = 'user_1'");
    let finish!: (customer: { id: string }) => void;
    customersCreate.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const checkout = createCheckoutSession(env, "user_1", "basic_monthly").catch(error => error);
    try {
      await vi.waitFor(() => expect(customersCreate).toHaveBeenCalledTimes(1));
      await admin.query("UPDATE users SET banned = true, ban_expires = NULL WHERE id = 'user_1'");
    } finally {
      finish({ id: "cus_too_late" });
    }
    expect(await checkout).toMatchObject({ code: "NOT_FOUND" });
    expect(checkoutCreate).not.toHaveBeenCalled();
    expect((await state()).user.stripe_customer_id).toBeNull();
  });

  it("uses the banned user's billing identity before account data is deleted", async () => {
    await admin.query("UPDATE users SET banned = true, stripe_subscription_id = NULL WHERE id = 'user_1'");
    await deleteAccountBilling(env, "user_1");
    expect(customersDelete).toHaveBeenCalledExactlyOnceWith("cus_1");
    expect((await state()).user.stripe_customer_id).toBe("cus_1");
  });

  it("ignores subscription metadata pointing to a different customer's user", async () => {
    constructEventAsync.mockResolvedValue(event("customer.subscription.updated", {
      ...subscription(), customer: "cus_2",
    }));
    const before = await state();
    expect((await deliver()).status).toBe(200);
    expect((await state()).user).toEqual(before.user);
    expect(subscriptionsRetrieve).not.toHaveBeenCalled();
  });

  it("does not access the database or Stripe subscriptions for an invalid signature", async () => {
    constructEventAsync.mockRejectedValue(new Error("bad signature"));
    const connect = vi.spyOn(pg.Client.prototype, "connect");
    expect((await deliver()).status).toBe(400);
    expect(connect).not.toHaveBeenCalled();
    expect(subscriptionsRetrieve).not.toHaveBeenCalled();
  });

  it("retries the same event after a Stripe lookup failure without keeping a receipt", async () => {
    subscriptionsRetrieve.mockRejectedValueOnce(new Error("Stripe temporarily unavailable"));
    const before = await state();
    expect((await deliver()).status).toBe(500);
    expect(await state()).toEqual(before);
    expect((await deliver()).status).toBe(200);
    expect(subscriptionsRetrieve).toHaveBeenCalledTimes(2);
    expect((await state()).user.plan_code).toBe("pro");
  });

  it.each(["write", "commit"])("rolls back the event and all changes on %s failure, allowing redelivery", async failure => {
    await admin.query(`CREATE FUNCTION reject_billing_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Cannot apply billing update'; END; $$;
      ${failure === "commit"
        ? "CREATE CONSTRAINT TRIGGER reject_billing_update AFTER UPDATE ON users DEFERRABLE INITIALLY DEFERRED"
        : "CREATE TRIGGER reject_billing_update BEFORE UPDATE ON users"}
      FOR EACH ROW EXECUTE FUNCTION reject_billing_update()`);
    try {
      const before = await state();
      expect((await deliver()).status).toBe(500);
      expect(await state()).toEqual(before);
    } finally {
      await admin.query("DROP TRIGGER reject_billing_update ON users; DROP FUNCTION reject_billing_update()");
    }
    expect((await deliver()).status).toBe(200);
    expect((await state()).user.plan_code).toBe("pro");
  });

  it("skips Stripe and user writes for an already committed event", async () => {
    expect((await deliver()).status).toBe(200);
    const before = await state();
    subscriptionsRetrieve.mockRejectedValue(new Error("should never be called again"));
    expect((await deliver()).status).toBe(200);
    expect(subscriptionsRetrieve).toHaveBeenCalledTimes(1);
    expect(await state()).toEqual(before);
  });

  it("applies simultaneous duplicate deliveries only once", async () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    let lookups = 0;
    subscriptionsRetrieve.mockImplementation(async () => {
      lookups++;
      if (lookups === 2) release();
      await ready;
      return subscription();
    });
    const first = deliver();
    const second = deliver();
    await vi.waitFor(() => expect(lookups).toBe(2)).catch(() => {});
    release();
    expect((await Promise.all([first, second])).map(res => res.status)).toEqual([200, 200]);
    expect(lookups).toBe(2);
    expect(await state()).toMatchObject({ events: [{ id: "evt_1" }], updates: [{ user_id: "user_1" }] });
  });

  it("closes database connections during Stripe I/O and preserves a new admin quota override", async () => {
    subscriptionsRetrieve.mockImplementation(async () => {
      expect((await admin.query("SELECT * FROM pg_stat_activity WHERE application_name = $1", [schema])).rows).toEqual([]);
      await admin.query("UPDATE users SET quota_source = 'admin', ai_answers_limit = 987 WHERE id = 'user_1'");
      return subscription();
    });
    expect((await deliver()).status).toBe(200);
    expect((await state()).user).toMatchObject({ quota_source: "admin", plan_code: "pro", ai_answers_limit: 987,
      max_video_upload_size_mb: 200, storage_limit_gb: 1, processing_limit_minutes: 45 });
  });

  it("lets a waiting duplicate recover when the first transaction fails", async () => {
    await admin.query(`CREATE SEQUENCE update_attempt;
      CREATE FUNCTION fail_first_update() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF nextval('update_attempt') = 1 THEN RAISE EXCEPTION 'First update fails'; END IF;
          RETURN NEW;
        END;
      $$;
      CREATE TRIGGER fail_first_update BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION fail_first_update()`);
    const writer = new pg.Client({ connectionString: env.HYPERDRIVE.connectionString });
    await writer.connect();
    let pending: Promise<Response[]> | undefined;
    try {
      await writer.query("BEGIN");
      await writer.query("SELECT id FROM users WHERE id = 'user_1' FOR UPDATE");
      pending = Promise.all([deliver(), deliver()]);
      await vi.waitFor(async () => {
        const blocked = await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND cardinality(pg_blocking_pids(pid)) > 0", [schema]);
        expect(blocked.rowCount).toBe(2);
      });
      // Neither a receipt nor a subscription update is visible before commit.
      expect(await state()).toMatchObject({ user: { plan_code: "free" }, events: [], updates: [] });
      await writer.query("COMMIT");
      expect((await pending).map(res => res.status).sort()).toEqual([200, 500]);
      expect(await state()).toMatchObject({ user: { plan_code: "pro" }, events: [{ id: "evt_1" }], updates: [{ user_id: "user_1" }] });
    } finally {
      await writer.query("ROLLBACK");
      await pending;
      await writer.end();
      await admin.query("DROP TRIGGER fail_first_update ON users; DROP FUNCTION fail_first_update(); DROP SEQUENCE update_attempt");
    }
  });

  it.each(["plan", "admin"])("uses the current %s quota source after waiting for the user row", async source => {
    const writer = new pg.Client({ connectionString: env.HYPERDRIVE.connectionString });
    await writer.connect();
    let pending: Promise<Response> | undefined;
    try {
      await admin.query("UPDATE users SET quota_source = 'admin', ai_answers_limit = 123 WHERE id = 'user_1'");
      await writer.query("BEGIN");
      await writer.query("UPDATE users SET quota_source = $1, ai_answers_limit = 987 WHERE id = 'user_1'", [source]);
      pending = deliver();
      await vi.waitFor(async () => {
        expect((await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND cardinality(pg_blocking_pids(pid)) > 0", [schema])).rowCount).toBe(1);
      });
      await writer.query("COMMIT");
      expect((await pending).status).toBe(200);
      expect((await state()).user).toMatchObject({ plan_code: "pro", quota_source: source, ai_answers_limit: source === "plan" ? 2000 : 987 });
    } finally {
      await writer.query("ROLLBACK");
      await pending;
      await writer.end();
    }
  });

  it.each(["active", "trialing", "past_due", "incomplete", "paused", "canceled", "unpaid", "incomplete_expired"])(
    "preserves subscription status handling for %s", async status => {
      subscriptionsRetrieve.mockResolvedValue(subscription(status, "basic_yearly"));
      constructEventAsync.mockResolvedValue(event("customer.subscription.updated", subscription(status, "basic_yearly")));
      expect((await deliver()).status).toBe(200);
      const active = ["active", "trialing", "past_due"].includes(status);
      expect((await state()).user).toMatchObject({ plan_code: active ? "basic" : "free",
        subscription_status: status, stripe_subscription_id: "sub_1",
        ...limits(active ? "basic" : "free") });
      expect(subscriptionsRetrieve).toHaveBeenCalledExactlyOnceWith("sub_1");
    },
  );

  it("resolves checkout users from metadata and expanded customer/subscription objects", async () => {
    constructEventAsync.mockResolvedValue(event("checkout.session.completed", { metadata: { userId: "user_1" },
      customer: { id: "cus_1" }, subscription: { id: "sub_1" } }));
    expect((await deliver()).status).toBe(200);
    expect(subscriptionsRetrieve).toHaveBeenCalledExactlyOnceWith("sub_1");
    expect((await state()).user.plan_code).toBe("pro");
  });

  it("resets an ended subscription to free using its current Stripe state", async () => {
    await admin.query("UPDATE users SET plan_code = 'pro', subscription_status = 'active', stripe_subscription_id = 'sub_1' WHERE id = 'user_1'");
    subscriptionsRetrieve.mockResolvedValue(subscription("canceled"));
    constructEventAsync.mockResolvedValue(event("customer.subscription.deleted", subscription("canceled")));
    expect((await deliver()).status).toBe(200);
    expect((await state()).user).toMatchObject({ plan_code: "free", subscription_status: "canceled", stripe_subscription_id: "sub_1", ...limits("free") });
    expect(subscriptionsRetrieve).toHaveBeenCalledExactlyOnceWith("sub_1");
  });

  it.each(["invoice.payment_failed", "invoice.paid", "checkout.session.completed"])("ignores standalone %s events", async type => {
    await admin.query("UPDATE users SET stripe_subscription_id = 'sub_existing', plan_code = 'basic', ai_answers_limit = 777 WHERE id = 'user_1'");
    const before = (await state()).user;
    constructEventAsync.mockResolvedValue(event(type, { customer: "cus_1", metadata: { userId: "user_1" }, parent: null, subscription: null }));
    expect((await deliver()).status).toBe(200);
    expect((await state()).user).toEqual(before);
    expect(subscriptionsRetrieve).not.toHaveBeenCalled();
  });

  it.each(["customer.subscription.updated", "invoice.payment_failed"])("does not restore an old status from a delayed %s event", async type => {
    constructEventAsync.mockResolvedValue(event(type, type === "customer.subscription.updated" ? subscription("past_due", "basic_monthly") : invoice()));
    subscriptionsRetrieve.mockResolvedValue(subscription("active", "pro_monthly"));
    expect((await deliver()).status).toBe(200);
    expect((await state()).user).toMatchObject({ plan_code: "pro", subscription_status: "active" });
  });

  it.each(["active", "canceled"])("does not replace a newer %s contract when an older cancellation arrives", async status => {
    await admin.query("UPDATE users SET stripe_subscription_id = 'sub_new' WHERE id = 'user_1'");
    subscriptionsRetrieve.mockImplementation(async id => id === "sub_new"
      ? { ...subscription(status), id, created: 200 } : subscription("canceled"));
    constructEventAsync.mockResolvedValue(event("customer.subscription.deleted", subscription("canceled")));
    expect((await deliver()).status).toBe(200);
    expect((await state()).user).toMatchObject({ stripe_subscription_id: "sub_new", subscription_status: status,
      plan_code: status === "active" ? "pro" : "free" });
  });

  it("accepts a new contract after cancellation, even within the same second", async () => {
    await admin.query("UPDATE users SET stripe_subscription_id = 'sub_old' WHERE id = 'user_1'");
    subscriptionsRetrieve.mockImplementation(async id => id === "sub_old"
      ? { ...subscription("canceled"), id } : subscription());
    expect((await deliver()).status).toBe(200);
    expect((await state()).user).toMatchObject({ stripe_subscription_id: "sub_1", plan_code: "pro" });
  });

  it("refreshes a stale lookup after a concurrent event commits, without persisting its old snapshot", async () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    subscriptionsRetrieve.mockImplementationOnce(async () => { await ready; return subscription("active", "basic_monthly"); });
    const first = deliver();
    try {
      await vi.waitFor(() => expect(subscriptionsRetrieve).toHaveBeenCalledTimes(1));
      constructEventAsync.mockResolvedValue({ ...event(), id: "evt_2" });
      expect((await deliver()).status).toBe(200);
    } finally { release(); }
    expect((await first).status).toBe(200);
    expect(subscriptionsRetrieve).toHaveBeenCalledTimes(3);
    expect(await state()).toMatchObject({ user: { plan_code: "pro" }, events: [{ id: "evt_1" }, { id: "evt_2" }] });
  });

  it.each(["missing_user", "missing_subscription", "unhandled"])("records %s events without changing users", async kind => {
    const object = invoice();
    if (kind === "missing_user") Object.assign(object, { metadata: { userId: "missing" } });
    if (kind === "missing_subscription") Object.assign(object, { parent: null });
    constructEventAsync.mockResolvedValue(event(kind === "unhandled" ? "invoice.created" : "invoice.paid", object));
    const before = (await state()).user;
    expect((await deliver()).status).toBe(200);
    expect(await state()).toMatchObject({ user: before, events: [{ id: "evt_1" }], updates: [] });
    expect(subscriptionsRetrieve).not.toHaveBeenCalled();
  });

});
