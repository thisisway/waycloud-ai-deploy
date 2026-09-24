<?php
declare(strict_types=1);

namespace WayCloud\Ai;

use WHMCS\Database\Capsule;

/** Creates the addon tables. Idempotent: safe to run again on upgrade. Deactivating never drops data. */
final class Schema
{
    public static function install(): void
    {
        $schema = Capsule::schema();

        if (!$schema->hasTable('mod_waycloud_checkouts')) {
            $schema->create('mod_waycloud_checkouts', function ($t) {
                $t->bigIncrements('id');
                $t->string('token_hash', 64)->unique();
                $t->string('session_id', 36)->index();
                $t->unsignedInteger('pid');
                $t->string('cycle', 12);
                $t->string('domain', 191);
                $t->string('status', 20)->index();
                $t->unsignedInteger('client_id')->nullable();
                $t->unsignedInteger('order_id')->nullable();
                $t->unsignedInteger('invoice_id')->nullable()->index();
                $t->unsignedInteger('service_id')->nullable()->index();
                $t->unsignedInteger('expires_at');
                $t->unsignedInteger('created_at');
                $t->unsignedInteger('updated_at');
            });
        }
        if (!$schema->hasTable('mod_waycloud_plan_map')) {
            $schema->create('mod_waycloud_plan_map', function ($t) {
                $t->string('type', 20)->primary();
                $t->unsignedInteger('pid');
            });
        }
        if (!$schema->hasTable('mod_waycloud_nonces')) {
            $schema->create('mod_waycloud_nonces', function ($t) {
                $t->string('nonce', 64)->primary();
                $t->unsignedInteger('seen_at')->index();
            });
        }
        if (!$schema->hasTable('mod_waycloud_outbox')) {
            $schema->create('mod_waycloud_outbox', function ($t) {
                $t->bigIncrements('id');
                $t->string('event', 40);
                $t->text('payload');
                $t->unsignedSmallInteger('attempts')->default(0);
                $t->unsignedInteger('next_attempt_at')->index();
                $t->unsignedInteger('sent_at')->nullable();
                $t->unsignedInteger('created_at');
            });
        }
        if (!$schema->hasTable('mod_waycloud_events')) {
            $schema->create('mod_waycloud_events', function ($t) {
                $t->bigIncrements('id');
                $t->string('type', 40);
                $t->string('ref', 64)->nullable();
                $t->text('data');
                $t->unsignedInteger('created_at');
            });
        }
    }
}
