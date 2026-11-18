import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { and, desc, eq, gt, inArray, sql, count } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { users, sessions, tickets, ticketHistory, transactions, supportConversations, supportMessages, appSettings } from "../../db/schema.ts";
import { createPaymentLink, flutterwaveConfigured, verifyByReference, webhookHashValid } from "./flutterwave.ts";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

const STATUSES = ["Ticket Created", "Ticket Confirmed", "Check-in Open", "Boarding", "Departed", "In Transit", "Delayed", "Landed", "Arrived", "Completed", "Cancelled"];
const STAFF_ROLES = ["support", "admin", "super_admin"];
const MANAGER_ROLES = ["admin", "super_admin"];
const SESSION_DAYS = 14;
const COOKIE = { site: "wp_session", admin: "wp_admin" } as const;
type Scope = keyof typeof COOKIE;
type User = typeof users.$inferSelect;

// ---------- helpers ----------
async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}
async function verifyPassword(password: string, stored: string) {
  const [, saltHex, keyHex] = stored.split("$");
  if (!saltHex || !keyHex) return false;
  const key = await scrypt(password, Buffer.from(saltHex, "hex"), 64);
  const expected = Buffer.from(keyHex, "hex");
  return key.length === expected.length && timingSafeEqual(key, expected);
}
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const shortId = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;
function randomCode(prefix: string, length: number) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return `${prefix}-${Array.from(randomBytes(length), (b) => alphabet[b % alphabet.length]).join("")}`;
}
const str = (value: unknown, max = 500) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const validEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const publicUser = (u: User) => ({ id: u.id, name: u.name, email: u.email, role: u.role, suspended: u.suspended, createdAt: u.createdAt });
function maskName(name = "") {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "Passenger";
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : `${parts[0][0]}.`;
}
async function body(c: Context): Promise<Record<string, unknown>> {
  try { const data = await c.req.json(); return data && typeof data === "object" ? data : {}; } catch { return {}; }
}
const fail = (c: Context, status: 400 | 401 | 403 | 404 | 409, error: string) => c.json({ error }, status);

async function startSession(c: Context, user: User, scope: Scope) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await db.insert(sessions).values({ token: sha256(token), userId: user.id, scope, expiresAt });
  setCookie(c, COOKIE[scope], token, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", expires: expiresAt });
}
async function endSession(c: Context, scope: Scope) {
  const token = getCookie(c, COOKIE[scope]);
  if (token) await db.delete(sessions).where(eq(sessions.token, sha256(token)));
  deleteCookie(c, COOKIE[scope], { path: "/", secure: true });
}
async function sessionUser(c: Context, scope: Scope): Promise<User | null> {
  const token = getCookie(c, COOKIE[scope]);
  if (!token) return null;
  const [row] = await db.select({ user: users }).from(sessions).innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.token, sha256(token)), eq(sessions.scope, scope), gt(sessions.expiresAt, new Date()))).limit(1);
  if (!row || row.user.suspended) return null;
  if (scope === "admin" && !STAFF_ROLES.includes(row.user.role)) return null;
  return row.user;
}
async function historyFor(ids: string[]) {
  if (!ids.length) return new Map<string, (typeof ticketHistory.$inferSelect)[]>();
  const rows = await db.select().from(ticketHistory).where(inArray(ticketHistory.ticketId, ids)).orderBy(ticketHistory.at);
  const map = new Map<string, typeof rows>();
  for (const row of rows) map.set(row.ticketId, [...(map.get(row.ticketId) || []), row]);
  return map;
}
async function withHistory(list: (typeof tickets.$inferSelect)[]) {
  const map = await historyFor(list.map((t) => t.id));
  return list.map((t) => ({ ...t, history: map.get(t.id) || [] }));
}
async function setTicketStatus(ticketId: string, status: string, announcement: string, source: string) {
  const [updated] = await db.update(tickets).set({ status, updatedAt: new Date() }).where(eq(tickets.id, ticketId)).returning();
  await db.insert(ticketHistory).values({ ticketId, status, announcement, source });
  return updated;
}
async function conversationThread(id: string) {
  const [conversation] = await db.select().from(supportConversations).where(eq(supportConversations.id, id)).limit(1);
  if (!conversation) return null;
  const messages = await db.select({ id: supportMessages.id, sender: supportMessages.sender, body: supportMessages.body, createdAt: supportMessages.createdAt, staffName: users.name })
    .from(supportMessages).leftJoin(users, eq(supportMessages.staffId, users.id))
    .where(eq(supportMessages.conversationId, id)).orderBy(supportMessages.createdAt);
  return { ...conversation, messages };
}
// Customers only see staff first names, never staff emails.
const customerThread = (t: NonNullable<Awaited<ReturnType<typeof conversationThread>>>) => ({
  id: t.id, subject: t.subject, status: t.status, createdAt: t.createdAt, updatedAt: t.updatedAt,
  messages: t.messages.map((m) => ({ sender: m.sender, body: m.body, createdAt: m.createdAt, staffName: m.sender === "staff" ? (m.staffName || "Customer care").split(" ")[0] : undefined })),
});

async function ticketPrice() {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, "ticket_price")).limit(1);
  const kobo = Number(row?.value || 0);
  return Number.isFinite(kobo) && kobo > 0 ? Math.round(kobo) : 0;
}
const paymentsActive = async () => flutterwaveConfigured() && (await ticketPrice()) > 0;

// Checks a transaction with Flutterwave and records the result. Safe to call repeatedly.
async function settleTransaction(reference: string) {
  const [txn] = await db.select().from(transactions).where(eq(transactions.reference, reference)).limit(1);
  if (!txn) return null;
  if (txn.status !== "pending") return txn;
  const remote = await verifyByReference(reference);
  if (!remote) return txn;
  const paidInFull = remote.status === "successful" && remote.currency === txn.currency && Math.round(remote.amount * 100) >= txn.amount;
  const nextStatus = paidInFull ? "successful" : remote.status === "failed" || remote.status === "successful" ? "failed" : "pending";
  if (nextStatus === "pending") return txn;
  const [updated] = await db.update(transactions).set({ status: nextStatus, providerTransactionId: String(remote.id) })
    .where(and(eq(transactions.id, txn.id), eq(transactions.status, "pending"))).returning();
  if (!updated) return (await db.select().from(transactions).where(eq(transactions.id, txn.id)).limit(1))[0];
  if (nextStatus === "successful" && txn.ticketId) {
    await db.update(tickets).set({ paymentStatus: "paid", updatedAt: new Date() }).where(eq(tickets.id, txn.ticketId));
    await db.insert(ticketHistory).values({ ticketId: txn.ticketId, status: "Ticket Created", announcement: "Payment confirmed. This tracking code is now active.", source: "Payment" });
  }
  return updated;
}

const app = new Hono();

app.get("/api/config", async (c) => {
  const price = await ticketPrice();
  return c.json({ ticketPrice: price, currency: "NGN", paymentsEnabled: flutterwaveConfigured() && price > 0 });
});

// ---------- customer accounts ----------
app.post("/api/auth/register", async (c) => {
  const data = await body(c);
  const name = str(data.name, 120), email = str(data.email, 200).toLowerCase(), password = typeof data.password === "string" ? data.password : "";
  if (!name || !validEmail(email)) return fail(c, 400, "Enter your name and a valid email address.");
  if (password.length < 6) return fail(c, 400, "Password must be at least 6 characters.");
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) return fail(c, 409, "An account with this email already exists. Log in instead.");
  const [user] = await db.insert(users).values({ id: shortId("USR"), name, email, passwordHash: await hashPassword(password) }).returning();
  await startSession(c, user, "site");
  return c.json({ user: publicUser(user) }, 201);
});
app.post("/api/auth/login", async (c) => {
  const data = await body(c);
  const email = str(data.email, 200).toLowerCase(), password = typeof data.password === "string" ? data.password : "";
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user || !(await verifyPassword(password, user.passwordHash))) return fail(c, 401, "Email or password is incorrect.");
  if (user.suspended) return fail(c, 403, "This account has been suspended. Contact customer care.");
  await startSession(c, user, "site");
  return c.json({ user: publicUser(user) });
});
app.post("/api/auth/logout", async (c) => { await endSession(c, "site"); return c.json({ ok: true }); });
app.get("/api/auth/me", async (c) => {
  const user = await sessionUser(c, "site");
  return c.json({ user: user ? publicUser(user) : null });
});

// ---------- customer tickets ----------
app.get("/api/tickets", async (c) => {
  const user = await sessionUser(c, "site");
  if (!user) return fail(c, 401, "Please log in.");
  const list = await db.select().from(tickets).where(eq(tickets.ownerId, user.id)).orderBy(desc(tickets.createdAt));
  return c.json({ tickets: await withHistory(list) });
});
app.post("/api/tickets", async (c) => {
  const user = await sessionUser(c, "site");
  if (!user) return fail(c, 401, "Please log in before creating a ticket.");
  const d = await body(c);
  const values = {
    passenger: str(d.passenger, 120), travelClass: str(d.travelClass, 40) || "Economy", seat: str(d.seat, 10) || null,
    airline: str(d.airline, 80), flightNumber: str(d.flightNumber, 20), departureAirport: str(d.departureAirport, 80),
    destinationAirport: str(d.destinationAirport, 80), departureDate: str(d.departureDate, 10), departureTime: str(d.departureTime, 5),
    arrivalDate: str(d.arrivalDate, 10), arrivalTime: str(d.arrivalTime, 5), notes: str(d.notes, 1000) || null,
  };
  const required = ["passenger", "airline", "flightNumber", "departureAirport", "destinationAirport", "departureDate", "departureTime", "arrivalDate", "arrivalTime"] as const;
  if (required.some((k) => !values[k])) return fail(c, 400, "Fill in all required fields.");
  if (`${values.arrivalDate}T${values.arrivalTime}` < `${values.departureDate}T${values.departureTime}`) return fail(c, 400, "Arrival must be after departure. Check the dates and times.");
  let code = randomCode("WP", 6);
  for (let i = 0; i < 5; i++) {
    const [clash] = await db.select({ id: tickets.id }).from(tickets).where(eq(tickets.code, code)).limit(1);
    if (!clash) break;
    code = randomCode("WP", 6);
  }
  const needsPayment = await paymentsActive();
  const [ticket] = await db.insert(tickets).values({ id: shortId("TKT"), code, ownerId: user.id, ...values, paymentStatus: needsPayment ? "unpaid" : "not_required" }).returning();
  await db.insert(ticketHistory).values({ ticketId: ticket.id, status: "Ticket Created", announcement: "A platform-generated flight record was created. Flight details have not been independently verified.", source: "User-entered record" });
  return c.json({ ticket, needsPayment }, 201);
});

// ---------- payments (Flutterwave) ----------
app.post("/api/tickets/:id/pay", async (c) => {
  const user = await sessionUser(c, "site");
  if (!user) return fail(c, 401, "Please log in.");
  const [ticket] = await db.select().from(tickets).where(and(eq(tickets.id, c.req.param("id")), eq(tickets.ownerId, user.id))).limit(1);
  if (!ticket) return fail(c, 404, "Ticket not found.");
  if (ticket.paymentStatus !== "unpaid") return fail(c, 400, "This ticket doesn't need a payment.");
  const amount = await ticketPrice();
  if (!flutterwaveConfigured() || amount <= 0) return fail(c, 400, "Payments are not available right now. Please contact customer care.");
  const reference = randomCode("WPX", 10);
  await db.insert(transactions).values({ id: shortId("TXN"), userId: user.id, ticketId: ticket.id, amount, currency: "NGN", status: "pending", provider: "flutterwave", reference, description: `Ticket ${ticket.code}` });
  const origin = new URL(c.req.url).origin;
  try {
    const link = await createPaymentLink({
      txRef: reference, amountNaira: amount / 100, currency: "NGN", redirectUrl: `${origin}/`,
      customer: { email: user.email, name: user.name }, title: "Waypoint", description: `Flight record ${ticket.code}`,
    });
    return c.json({ link, reference });
  } catch (err) {
    await db.update(transactions).set({ status: "failed" }).where(eq(transactions.reference, reference));
    return fail(c, 400, (err as Error).message);
  }
});
// Called by the website when Flutterwave redirects the customer back.
app.get("/api/payments/verify", async (c) => {
  const user = await sessionUser(c, "site");
  if (!user) return fail(c, 401, "Please log in.");
  const reference = str(c.req.query("tx_ref"), 40);
  const [txn] = await db.select().from(transactions).where(and(eq(transactions.reference, reference), eq(transactions.userId, user.id))).limit(1);
  if (!txn) return fail(c, 404, "Payment not found.");
  const settled = await settleTransaction(reference);
  const [ticket] = txn.ticketId ? await db.select({ code: tickets.code }).from(tickets).where(eq(tickets.id, txn.ticketId)).limit(1) : [];
  return c.json({ status: settled?.status || txn.status, ticketCode: ticket?.code || null });
});
// Flutterwave server-to-server notification. Always re-verified with the API.
app.post("/api/payments/webhook", async (c) => {
  if (!webhookHashValid(c.req.header("verif-hash"))) return c.json({ error: "Invalid signature" }, 401);
  const payload = await body(c);
  const data = (payload.data || {}) as Record<string, unknown>;
  const reference = str(data.tx_ref ?? data.txRef, 40);
  if (reference) await settleTransaction(reference);
  return c.json({ ok: true });
});
app.patch("/api/tickets/:id/status", async (c) => {
  const user = await sessionUser(c, "site");
  if (!user) return fail(c, 401, "Please log in.");
  const status = str((await body(c)).status, 40);
  if (!STATUSES.includes(status)) return fail(c, 400, "Choose a valid status.");
  const [ticket] = await db.select().from(tickets).where(and(eq(tickets.id, c.req.param("id")), eq(tickets.ownerId, user.id))).limit(1);
  if (!ticket) return fail(c, 404, "You can only update tickets in your account.");
  const updated = await setTicketStatus(ticket.id, status, `Ticket status updated by the record owner to ${status}.`, "User-entered record");
  return c.json({ ticket: updated });
});

// ---------- public tracking ----------
app.get("/api/track/:code", async (c) => {
  const code = str(c.req.param("code"), 20).toUpperCase();
  const [ticket] = await db.select().from(tickets).where(eq(tickets.code, code)).limit(1);
  if (!ticket) return fail(c, 404, "Not found");
  if (ticket.paymentStatus === "unpaid") return c.json({ error: "This tracking code is awaiting payment.", awaitingPayment: true }, 402);
  const history = (await historyFor([ticket.id])).get(ticket.id) || [];
  return c.json({ ticket: {
    id: ticket.id, code: ticket.code, airline: ticket.airline, flightNumber: ticket.flightNumber, status: ticket.status,
    departureAirport: ticket.departureAirport, destinationAirport: ticket.destinationAirport,
    departureDate: ticket.departureDate, departureTime: ticket.departureTime, arrivalDate: ticket.arrivalDate, arrivalTime: ticket.arrivalTime,
    passenger: maskName(ticket.passenger), travelClass: ticket.travelClass, seat: ticket.seat, updatedAt: ticket.updatedAt,
    history: history.map((h) => ({ status: h.status, announcement: h.announcement, at: h.at })),
  } });
});

// ---------- customer care (customer side) ----------
app.post("/api/support", async (c) => {
  const user = await sessionUser(c, "site");
  const d = await body(c);
  const name = user?.name || str(d.name, 120), email = user?.email || str(d.email, 200).toLowerCase();
  const subject = str(d.subject, 150), message = str(d.message, 4000);
  if (!name || !validEmail(email)) return fail(c, 400, "Enter your name and a valid email address.");
  if (!subject || !message) return fail(c, 400, "Enter a subject and a message.");
  const [conversation] = await db.insert(supportConversations).values({ id: randomCode("CS", 8), userId: user?.id || null, name, email, subject }).returning();
  await db.insert(supportMessages).values({ conversationId: conversation.id, sender: "customer", body: message });
  return c.json({ reference: conversation.id }, 201);
});
app.get("/api/support/mine", async (c) => {
  const user = await sessionUser(c, "site");
  if (!user) return fail(c, 401, "Please log in.");
  const list = await db.select().from(supportConversations).where(eq(supportConversations.userId, user.id)).orderBy(desc(supportConversations.updatedAt));
  return c.json({ conversations: list.map((x) => ({ id: x.id, subject: x.subject, status: x.status, updatedAt: x.updatedAt })) });
});
async function customerCanAccess(c: Context, conversationId: string, email: string) {
  const thread = await conversationThread(conversationId);
  if (!thread) return null;
  const user = await sessionUser(c, "site");
  if (user && thread.userId === user.id) return thread;
  if (email && email.toLowerCase() === thread.email.toLowerCase()) return thread;
  return null;
}
app.get("/api/support/:id", async (c) => {
  const thread = await customerCanAccess(c, str(c.req.param("id"), 20).toUpperCase(), str(c.req.query("email"), 200));
  if (!thread) return fail(c, 404, "We couldn't find a support request with that reference and email.");
  return c.json({ conversation: customerThread(thread) });
});
app.post("/api/support/:id/messages", async (c) => {
  const d = await body(c);
  const thread = await customerCanAccess(c, str(c.req.param("id"), 20).toUpperCase(), str(d.email, 200));
  if (!thread) return fail(c, 404, "Support request not found.");
  const message = str(d.message, 4000);
  if (!message) return fail(c, 400, "Write a message first.");
  await db.insert(supportMessages).values({ conversationId: thread.id, sender: "customer", body: message });
  await db.update(supportConversations).set({ status: "open", updatedAt: new Date() }).where(eq(supportConversations.id, thread.id));
  return c.json({ conversation: customerThread((await conversationThread(thread.id))!) });
});

// ---------- admin: setup & sign-in ----------
async function adminExists() {
  const [row] = await db.select({ n: count() }).from(users).where(inArray(users.role, MANAGER_ROLES));
  return Number(row?.n || 0) > 0;
}
app.get("/api/admin/setup-status", async (c) => c.json({ needsSetup: !(await adminExists()) }));
app.post("/api/admin/setup", async (c) => {
  if (await adminExists()) return fail(c, 403, "An administrator already exists. Sign in instead.");
  const d = await body(c);
  const name = str(d.name, 120), email = str(d.email, 200).toLowerCase(), password = typeof d.password === "string" ? d.password : "";
  if (!name || !validEmail(email)) return fail(c, 400, "Enter your name and a valid email address.");
  if (password.length < 8) return fail(c, 400, "Password must be at least 8 characters.");
  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  let user: User;
  if (existing) {
    if (!(await verifyPassword(password, existing.passwordHash))) return fail(c, 409, "This email already has an account. Enter its current password to make it an admin.");
    [user] = await db.update(users).set({ role: "super_admin", suspended: false }).where(eq(users.id, existing.id)).returning();
  } else {
    [user] = await db.insert(users).values({ id: shortId("USR"), name, email, passwordHash: await hashPassword(password), role: "super_admin" }).returning();
  }
  await startSession(c, user, "admin");
  return c.json({ user: publicUser(user) }, 201);
});
app.post("/api/admin/login", async (c) => {
  const d = await body(c);
  const email = str(d.email, 200).toLowerCase(), password = typeof d.password === "string" ? d.password : "";
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user || !(await verifyPassword(password, user.passwordHash)) || !STAFF_ROLES.includes(user.role) || user.suspended) {
    return fail(c, 401, "Sign-in failed. Use an active admin or customer care account.");
  }
  await startSession(c, user, "admin");
  return c.json({ user: publicUser(user) });
});
app.post("/api/admin/logout", async (c) => { await endSession(c, "admin"); return c.json({ ok: true }); });

// Everything below requires a staff session.
app.use("/api/admin/*", async (c, next) => {
  const open = ["/api/admin/setup-status", "/api/admin/setup", "/api/admin/login", "/api/admin/logout"];
  if (open.includes(c.req.path)) return next();
  const staff = await sessionUser(c, "admin");
  if (!staff) return fail(c, 401, "Please sign in.");
  c.set("staff" as never, staff as never);
  return next();
});
const staffOf = (c: Context) => c.get("staff" as never) as unknown as User;
const isManager = (u: User) => MANAGER_ROLES.includes(u.role);

app.get("/api/admin/me", (c) => c.json({ user: publicUser(staffOf(c)) }));

app.get("/api/admin/tickets", async (c) => {
  const list = await db.select({ ticket: tickets, ownerName: users.name, ownerEmail: users.email }).from(tickets)
    .leftJoin(users, eq(tickets.ownerId, users.id)).orderBy(desc(tickets.createdAt));
  const map = await historyFor(list.map((r) => r.ticket.id));
  return c.json({ tickets: list.map((r) => ({ ...r.ticket, ownerName: r.ownerName, ownerEmail: r.ownerEmail, history: map.get(r.ticket.id) || [] })) });
});
app.patch("/api/admin/tickets/:id/status", async (c) => {
  const staff = staffOf(c);
  const status = str((await body(c)).status, 40);
  if (!STATUSES.includes(status)) return fail(c, 400, "Choose a valid status.");
  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, c.req.param("id"))).limit(1);
  if (!ticket) return fail(c, 404, "Ticket not found.");
  if (ticket.status === status) return fail(c, 400, "This ticket already has that status.");
  const updated = await setTicketStatus(ticket.id, status, `Status changed from ${ticket.status} to ${status} by ${staff.name}.`, "Waypoint operations");
  return c.json({ ticket: updated });
});

app.get("/api/admin/users", async (c) => {
  const ticketCounts = db.select({ ownerId: tickets.ownerId, n: count().as("ticket_count") }).from(tickets).groupBy(tickets.ownerId).as("tc");
  const paid = db.select({ userId: transactions.userId, total: sql<number>`coalesce(sum(${transactions.amount}) filter (where ${transactions.status} = 'successful'), 0)`.as("paid_total"), n: count().as("txn_count") })
    .from(transactions).groupBy(transactions.userId).as("tx");
  const rows = await db.select({ user: users, tickets: ticketCounts.n, transactions: paid.n, paidTotal: paid.total }).from(users)
    .leftJoin(ticketCounts, eq(ticketCounts.ownerId, users.id)).leftJoin(paid, eq(paid.userId, users.id)).orderBy(desc(users.createdAt));
  return c.json({ users: rows.map((r) => ({ ...publicUser(r.user), tickets: Number(r.tickets || 0), transactions: Number(r.transactions || 0), paidTotal: Number(r.paidTotal || 0) })) });
});
app.patch("/api/admin/users/:id", async (c) => {
  const staff = staffOf(c);
  if (!isManager(staff)) return fail(c, 403, "Only administrators can change accounts.");
  const [target] = await db.select().from(users).where(eq(users.id, c.req.param("id"))).limit(1);
  if (!target) return fail(c, 404, "User not found.");
  if (target.id === staff.id) return fail(c, 400, "You can't change your own account here.");
  if (target.role === "super_admin" && staff.role !== "super_admin") return fail(c, 403, "Only a super admin can change another super admin.");
  const d = await body(c);
  const changes: Partial<User> = {};
  if (typeof d.suspended === "boolean") changes.suspended = d.suspended;
  if (typeof d.role === "string") {
    const allowed = staff.role === "super_admin" ? ["user", "support", "admin", "super_admin"] : ["user", "support"];
    if (!allowed.includes(d.role)) return fail(c, 403, "You can't assign that role.");
    changes.role = d.role;
  }
  if (!Object.keys(changes).length) return fail(c, 400, "Nothing to change.");
  const [updated] = await db.update(users).set(changes).where(eq(users.id, target.id)).returning();
  if (changes.suspended || (changes.role && !STAFF_ROLES.includes(changes.role))) {
    await db.delete(sessions).where(and(eq(sessions.userId, target.id), changes.suspended ? sql`true` : eq(sessions.scope, "admin")));
  }
  return c.json({ user: publicUser(updated) });
});
app.post("/api/admin/staff", async (c) => {
  const staff = staffOf(c);
  if (!isManager(staff)) return fail(c, 403, "Only administrators can add staff.");
  const d = await body(c);
  const name = str(d.name, 120), email = str(d.email, 200).toLowerCase(), password = typeof d.password === "string" ? d.password : "";
  const role = str(d.role, 20) || "support";
  const allowed = staff.role === "super_admin" ? ["support", "admin"] : ["support"];
  if (!allowed.includes(role)) return fail(c, 403, "You can't create that kind of account.");
  if (!name || !validEmail(email)) return fail(c, 400, "Enter a name and a valid email address.");
  if (password.length < 8) return fail(c, 400, "Temporary password must be at least 8 characters.");
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) return fail(c, 409, "That email already has an account. Change its role in the Users list instead.");
  const [user] = await db.insert(users).values({ id: shortId("USR"), name, email, passwordHash: await hashPassword(password), role }).returning();
  return c.json({ user: publicUser(user) }, 201);
});

app.get("/api/admin/settings", async (c) => {
  return c.json({ ticketPrice: await ticketPrice(), currency: "NGN", flutterwaveConnected: flutterwaveConfigured(), webhookConfigured: Boolean(process.env.FLW_SECRET_HASH) });
});
app.put("/api/admin/settings", async (c) => {
  if (!isManager(staffOf(c))) return fail(c, 403, "Only administrators can change settings.");
  const naira = Number((await body(c)).ticketPriceNaira);
  if (!Number.isFinite(naira) || naira < 0 || naira > 10_000_000) return fail(c, 400, "Enter a valid price in naira (0 for free).");
  const kobo = String(Math.round(naira * 100));
  await db.insert(appSettings).values({ key: "ticket_price", value: kobo }).onConflictDoUpdate({ target: appSettings.key, set: { value: kobo, updatedAt: new Date() } });
  return c.json({ ticketPrice: Number(kobo) });
});
app.post("/api/admin/transactions/:reference/verify", async (c) => {
  const settled = await settleTransaction(c.req.param("reference"));
  if (!settled) return fail(c, 404, "Transaction not found.");
  return c.json({ transaction: settled });
});

app.get("/api/admin/transactions", async (c) => {
  const rows = await db.select({ txn: transactions, userName: users.name, userEmail: users.email, ticketCode: tickets.code }).from(transactions)
    .leftJoin(users, eq(transactions.userId, users.id)).leftJoin(tickets, eq(transactions.ticketId, tickets.id)).orderBy(desc(transactions.createdAt));
  return c.json({ transactions: rows.map((r) => ({ ...r.txn, userName: r.userName, userEmail: r.userEmail, ticketCode: r.ticketCode })) });
});

// ---------- admin: customer care ----------
app.get("/api/admin/support", async (c) => {
  const last = db.select({ conversationId: supportMessages.conversationId, n: count().as("message_count"), lastSender: sql<string>`(array_agg(${supportMessages.sender} order by ${supportMessages.createdAt} desc))[1]`.as("last_sender") })
    .from(supportMessages).groupBy(supportMessages.conversationId).as("lm");
  const rows = await db.select({ conv: supportConversations, messages: last.n, lastSender: last.lastSender, assignedName: users.name }).from(supportConversations)
    .leftJoin(last, eq(last.conversationId, supportConversations.id)).leftJoin(users, eq(users.id, supportConversations.assignedTo))
    .orderBy(desc(supportConversations.updatedAt));
  return c.json({ conversations: rows.map((r) => ({ ...r.conv, messages: Number(r.messages || 0), awaitingReply: r.conv.status === "open" && r.lastSender === "customer", assignedName: r.assignedName })) });
});
app.get("/api/admin/support/:id", async (c) => {
  const thread = await conversationThread(c.req.param("id"));
  if (!thread) return fail(c, 404, "Conversation not found.");
  return c.json({ conversation: thread });
});
app.post("/api/admin/support/:id/messages", async (c) => {
  const staff = staffOf(c);
  const message = str((await body(c)).message, 4000);
  if (!message) return fail(c, 400, "Write a reply first.");
  const thread = await conversationThread(c.req.param("id"));
  if (!thread) return fail(c, 404, "Conversation not found.");
  await db.insert(supportMessages).values({ conversationId: thread.id, sender: "staff", staffId: staff.id, body: message });
  await db.update(supportConversations).set({ updatedAt: new Date(), assignedTo: thread.assignedTo || staff.id }).where(eq(supportConversations.id, thread.id));
  return c.json({ conversation: await conversationThread(thread.id) });
});
app.patch("/api/admin/support/:id", async (c) => {
  const d = await body(c);
  const changes: Partial<typeof supportConversations.$inferInsert> = { updatedAt: new Date() };
  if (d.status === "open" || d.status === "closed") changes.status = d.status;
  if (d.assignToMe) changes.assignedTo = staffOf(c).id;
  const [updated] = await db.update(supportConversations).set(changes).where(eq(supportConversations.id, c.req.param("id"))).returning();
  if (!updated) return fail(c, 404, "Conversation not found.");
  return c.json({ conversation: await conversationThread(updated.id) });
});

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => { console.error(err); return c.json({ error: "Something went wrong. Please try again." }, 500); });

export const config = { path: "/api/*" };
export default app;
