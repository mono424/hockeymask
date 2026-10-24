CREATE TYPE "public"."warehouse_type" AS ENUM('WAREHOUSE', 'STORE', 'THIRD_PARTY');--> statement-breakpoint
CREATE TABLE "category" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"source_system" text,
	"source_id" text,
	"secondary_source_id" text DEFAULT '' NOT NULL,
	"name" text NOT NULL,
	"parent_id" integer,
	CONSTRAINT "uq_category_external_identity" UNIQUE("company_id","source_system","source_id","secondary_source_id")
);
--> statement-breakpoint
CREATE TABLE "company" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_level" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"warehouse_id" integer NOT NULL,
	"on_hand" integer NOT NULL,
	"reserved" integer,
	"as_of" date NOT NULL,
	CONSTRAINT "uq_inventory_level" UNIQUE("product_id","warehouse_id")
);
--> statement-breakpoint
CREATE TABLE "mapping_graph" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"name" text NOT NULL,
	"document" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"source_system" text,
	"source_id" text,
	"secondary_source_id" text DEFAULT '' NOT NULL,
	"title" text NOT NULL,
	"sku" text NOT NULL,
	"ean" text,
	"price" double precision,
	"cost" double precision,
	"category_id" integer,
	"weight" double precision,
	"length" double precision,
	"width" double precision,
	"height" double precision,
	"active" boolean,
	"launch_date" date,
	CONSTRAINT "uq_product_external_identity" UNIQUE("company_id","source_system","source_id","secondary_source_id")
);
--> statement-breakpoint
CREATE TABLE "supplier" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"source_system" text,
	"source_id" text,
	"secondary_source_id" text DEFAULT '' NOT NULL,
	"name" text NOT NULL,
	"currency" text,
	"country" text,
	"lead_time_days" integer,
	CONSTRAINT "uq_supplier_external_identity" UNIQUE("company_id","source_system","source_id","secondary_source_id")
);
--> statement-breakpoint
CREATE TABLE "supplier_product" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"supplier_id" integer NOT NULL,
	"supplier_sku" text,
	"purchase_price" double precision,
	"preferred" boolean,
	CONSTRAINT "uq_supplier_product" UNIQUE("product_id","supplier_id")
);
--> statement-breakpoint
CREATE TABLE "target_entity_edit" (
	"company_id" integer NOT NULL,
	"name" text NOT NULL,
	"document" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "target_entity_edit_company_id_name_pk" PRIMARY KEY("company_id","name")
);
--> statement-breakpoint
CREATE TABLE "warehouse" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"source_system" text,
	"source_id" text,
	"secondary_source_id" text DEFAULT '' NOT NULL,
	"name" text NOT NULL,
	"type" "warehouse_type",
	"country" text,
	"city" text,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "uq_warehouse_external_identity" UNIQUE("company_id","source_system","source_id","secondary_source_id")
);
--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_parent_id_category_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_level" ADD CONSTRAINT "inventory_level_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_level" ADD CONSTRAINT "inventory_level_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_level" ADD CONSTRAINT "inventory_level_warehouse_id_warehouse_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouse"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mapping_graph" ADD CONSTRAINT "mapping_graph_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier" ADD CONSTRAINT "supplier_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_product" ADD CONSTRAINT "supplier_product_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_product" ADD CONSTRAINT "supplier_product_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_product" ADD CONSTRAINT "supplier_product_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supplier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "target_entity_edit" ADD CONSTRAINT "target_entity_edit_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;