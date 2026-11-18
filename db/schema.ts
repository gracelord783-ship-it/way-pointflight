import { pgTable, text, timestamp, integer, boolean, serial, index } from "drizzle-orm/pg-core";

// role: user | support | admin | super_admin
export const users = pgTable("users", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text().notNull().default("user"),
  suspended: boolean().notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  token: text().primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  scope: text().notNull().default("site"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [index("sessions_user_idx").on(t.userId)]);

export const tickets = pgTable("tickets", {
  id: text().primaryKey(),
  code: text().notNull().unique(),
  ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  passenger: text().notNull(),
  travelClass: text("travel_class").notNull().default("Economy"),
  seat: text(),
  airline: text().notNull(),
  flightNumber: text("flight_number").notNull(),
  departureAirport: text("departure_airport").notNull(),
  destinationAirport: text("destination_airport").notNull(),
  departureDate: text("departure_date").notNull(),
  departureTime: text("departure_time").notNull(),
  arrivalDate: text("arrival_date").notNull(),
  arrivalTime: text("arrival_time").notNull(),
  notes: text(),
  status: text().notNull().default("Ticket Created"),
  // not_required | unpaid | paid
  paymentStatus: text("payment_status").notNull().default("not_required"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("tickets_owner_idx").on(t.ownerId)]);

export const ticketHistory = pgTable("ticket_history", {
  id: serial().primaryKey(),
  ticketId: text("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
  status: text().notNull(),
  announcement: text().notNull(),
  source: text().notNull(),
  at: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("ticket_history_ticket_idx").on(t.ticketId)]);

// Payments made through Flutterwave.
export const transactions = pgTable("transactions", {
  id: text().primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  ticketId: text("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
  amount: integer().notNull(), // in kobo (1/100 naira)
  currency: text().notNull().default("NGN"),
  status: text().notNull().default("pending"), // pending | successful | failed | refunded
  provider: text().notNull().default("flutterwave"),
  reference: text().notNull().unique(), // tx_ref sent to Flutterwave
  providerTransactionId: text("provider_transaction_id"),
  description: text(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const supportConversations = pgTable("support_conversations", {
  id: text().primaryKey(), // CS-XXXXXX, shown to customers as their reference
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  name: text().notNull(),
  email: text().notNull(),
  subject: text().notNull(),
  status: text().notNull().default("open"), // open | closed
  assignedTo: text("assigned_to").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const supportMessages = pgTable("support_messages", {
  id: serial().primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => supportConversations.id, { onDelete: "cascade" }),
  sender: text().notNull(), // customer | staff
  staffId: text("staff_id").references(() => users.id, { onDelete: "set null" }),
  body: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("support_messages_conv_idx").on(t.conversationId)]);

// Simple key/value settings editable by admins (e.g. ticket_price in kobo).
export const appSettings = pgTable("app_settings", {
  key: text().primaryKey(),
  value: text().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
