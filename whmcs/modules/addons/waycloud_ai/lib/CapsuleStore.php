<?php
declare(strict_types=1);

namespace WayCloud\Ai;

use WHMCS\Database\Capsule;

/** Store on the WHMCS database (Capsule = Laravel's query builder). */
final class CapsuleStore implements Store
{
    private const CHECKOUTS = 'mod_waycloud_checkouts';

    public function createCheckout(array $row): int
    {
        return (int) Capsule::table(self::CHECKOUTS)->insertGetId($row);
    }

    public function findCheckoutByTokenHash(string $hash): ?array
    {
        $r = Capsule::table(self::CHECKOUTS)->where('token_hash', $hash)->first();
        return $r === null ? null : (array) $r;
    }

    public function findCheckoutBy(string $column, int $value): ?array
    {
        if (!in_array($column, ['id', 'invoice_id', 'service_id'], true)) {
            throw new \InvalidArgumentException('column not allowed');
        }
        $r = Capsule::table(self::CHECKOUTS)->where($column, $value)->first();
        return $r === null ? null : (array) $r;
    }

    public function updateCheckout(int $id, array $fields, ?array $onlyIfStatus = null): bool
    {
        $q = Capsule::table(self::CHECKOUTS)->where('id', $id);
        if ($onlyIfStatus !== null) {
            $q->whereIn('status', $onlyIfStatus); // compare-and-set in a single UPDATE
        }
        return $q->update($fields + ['updated_at' => time()]) > 0;
    }

    public function cancelOpenCheckouts(string $sessionId): void
    {
        Capsule::table(self::CHECKOUTS)
            ->where('session_id', $sessionId)
            ->whereIn('status', ['new', 'client_created'])
            ->update(['status' => 'cancelled', 'updated_at' => time()]);
    }

    public function planMap(): array
    {
        $out = [];
        foreach (Capsule::table('mod_waycloud_plan_map')->get() as $r) {
            $out[(string) $r->type] = (int) $r->pid;
        }
        return $out;
    }

    public function savePlanMap(array $map): void
    {
        Capsule::table('mod_waycloud_plan_map')->delete();
        foreach ($map as $type => $pid) {
            Capsule::table('mod_waycloud_plan_map')->insert(['type' => (string) $type, 'pid' => (int) $pid]);
        }
    }

    public function recordNonce(string $nonce, int $ts): bool
    {
        return Capsule::table('mod_waycloud_nonces')->insertOrIgnore(['nonce' => $nonce, 'seen_at' => $ts]) > 0;
    }

    public function purgeNonces(int $olderThan): void
    {
        Capsule::table('mod_waycloud_nonces')->where('seen_at', '<', $olderThan)->delete();
    }

    public function queueEvent(string $event, array $payload, int $now): int
    {
        return (int) Capsule::table('mod_waycloud_outbox')->insertGetId([
            'event' => $event,
            'payload' => (string) json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
            'attempts' => 0,
            'next_attempt_at' => $now,
            'created_at' => $now,
        ]);
    }

    public function dueEvents(int $now, int $limit): array
    {
        $out = [];
        foreach (Capsule::table('mod_waycloud_outbox')->whereNull('sent_at')->where('next_attempt_at', '<=', $now)->orderBy('id')->limit($limit)->get() as $r) {
            $out[] = (array) $r;
        }
        return $out;
    }

    public function markEventSent(int $id, int $now): void
    {
        Capsule::table('mod_waycloud_outbox')->where('id', $id)->update(['sent_at' => $now]);
    }

    public function markEventFailed(int $id, int $attempts, int $nextAttemptAt): void
    {
        Capsule::table('mod_waycloud_outbox')->where('id', $id)->update(['attempts' => $attempts, 'next_attempt_at' => $nextAttemptAt]);
    }

    public function logEvent(string $type, ?string $ref, array $data, int $now): void
    {
        Capsule::table('mod_waycloud_events')->insert([
            'type' => $type,
            'ref' => $ref,
            'data' => (string) json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
            'created_at' => $now,
        ]);
    }

    public function recentCheckouts(int $limit): array
    {
        $out = [];
        // token_hash is deliberately not selected
        foreach (Capsule::table(self::CHECKOUTS)->select('id', 'session_id', 'pid', 'cycle', 'domain', 'status', 'client_id', 'order_id', 'invoice_id', 'service_id', 'created_at')->orderBy('id', 'desc')->limit($limit)->get() as $r) {
            $out[] = (array) $r;
        }
        return $out;
    }

    public function recentEvents(int $limit): array
    {
        $out = [];
        foreach (Capsule::table('mod_waycloud_events')->orderBy('id', 'desc')->limit($limit)->get() as $r) {
            $out[] = (array) $r;
        }
        return $out;
    }

    public function pendingOutbox(): int
    {
        return (int) Capsule::table('mod_waycloud_outbox')->whereNull('sent_at')->count();
    }
}
