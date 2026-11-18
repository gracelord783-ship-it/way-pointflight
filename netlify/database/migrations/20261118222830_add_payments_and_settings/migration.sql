CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "payment_status" text DEFAULT 'not_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "provider_transaction_id" text;--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "provider" SET DEFAULT 'flutterwave';